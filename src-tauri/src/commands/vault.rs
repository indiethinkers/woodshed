// Vault commands: scaffold and detect.

use crate::commands::{config, seed};
use crate::vault as vault_lib;
use serde::Serialize;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const VAULT_GIT_REMOTE: &str = "origin";
const VAULT_GIT_BRANCH: &str = "main";

#[tauri::command]
pub fn vault_init(path: String, seed_samples: bool) -> Result<(), String> {
    let p = PathBuf::from(&path);
    vault_lib::ensure_dirs(&p).map_err(|e| e.to_string())?;
    if seed_samples {
        seed::seed_all(&p)?;
    }
    Ok(())
}

/// Point Woodshed at a different vault and relaunch.
///
/// The relaunch is the design, not a shortcut. `watcher_start` is the single
/// place that scaffolds directories, runs migrations, hydrates the events,
/// people and calendar caches, grants the attachment asset scope, and opens the
/// search index — and it deliberately refuses to run twice
/// (`commands/watcher.rs:50`). Redoing all of that in-process would mean tearing
/// down every one of those caches by hand, and the asset scope granted for the
/// old vault's `attachments/` cannot be revoked, so a live switch would quietly
/// leave the previous vault reachable. Restarting reruns the whole boot path
/// against the new vault with no special cases.
///
/// Every fallible step runs before anything is committed, so a rejected path
/// leaves the configured vault untouched.
#[tauri::command]
pub fn vault_switch(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let current = config::vault_path_get(app.clone())?;
    let target = resolve_switch_target(&path, current.as_deref())?;

    // Refuse arbitrary folders before touching anything. Adopting a folder is
    // not read-only: `ensure_dirs` scaffolds sixteen subdirectories into it,
    // and the boot migration after the restart renames `calendar/` and
    // `daily/` contents into `cadence/` and rewrites every `.md` under
    // `resources/`. A mis-click in the folder picker must not be able to
    // rearrange someone's files.
    ensure_safe_to_adopt(&target)?;

    // Scaffold any missing canonical subdirs. Non-destructive: `ensure_dirs`
    // creates what is absent and leaves existing data alone, so pointing at a
    // folder that is already a vault is safe.
    vault_lib::ensure_dirs(&target)
        .map_err(|e| format!("Cannot use {} as a vault: {e:#}", target.display()))?;

    // The search index is a single database keyed to vault-relative paths, so
    // the outgoing vault's rows would surface as dead search hits against the
    // new one. Dropping it is safe — it is derived state, and `watcher_start`
    // rebuilds when `document_count()` is zero. Done before the path is
    // written so a failure here leaves the old vault fully intact; losing the
    // index for the *current* vault would only cost one rebuild anyway.
    discard_search_index(&app)?;

    config::vault_path_set(app.clone(), target.to_string_lossy().to_string())?;
    crate::log_info!("vault::switch", "switched vault, restarting");

    // Never returns.
    app.restart();
}

/// Validate a requested vault path against the configured one.
///
/// Split out from [`vault_switch`] so the rules that decide whether a restart
/// is warranted are testable without an `AppHandle`. Both paths are
/// canonicalized before comparison so `..`, a trailing slash, or a symlink
/// cannot disguise the current vault as a different one and trigger a pointless
/// relaunch.
fn resolve_switch_target(requested: &str, current: Option<&str>) -> Result<PathBuf, String> {
    let requested = PathBuf::from(requested.trim());
    if requested.as_os_str().is_empty() {
        return Err("Choose a folder for your vault.".to_string());
    }

    let target = requested
        .canonicalize()
        .map_err(|e| format!("Cannot open {}: {e}", requested.display()))?;
    if !target.is_dir() {
        return Err(format!("{} is not a folder.", target.display()));
    }

    let already_current = current
        .map(PathBuf::from)
        .and_then(|c| c.canonicalize().ok())
        .is_some_and(|c| c == target);
    if already_current {
        return Err("That is already your vault.".to_string());
    }

    Ok(target)
}

/// How many canonical subdirectories a non-empty folder must already have
/// before it is treated as an existing vault rather than someone's documents.
/// Three is enough that an incidental `resources/` or `tables/` does not
/// qualify, and low enough that a partially-populated vault still does.
const VAULT_RECOGNITION_THRESHOLD: usize = 3;

/// Reject folders that are neither empty nor already a vault.
///
/// Adopting a folder mutates it. `ensure_dirs` scaffolds every entry in
/// `VAULT_SUBDIRS`, and the migration that runs on the next boot
/// (`vault::migration::migrate_legacy_folders`) renames the contents of
/// `calendar/` and `daily/` into `cadence/` and rewrites the frontmatter of
/// every `.md` under `resources/`. Those are the right behaviours for a vault
/// and the wrong ones for a folder the user picked by accident.
///
/// Dotfiles do not count as content: a `.git` directory is expected on a
/// git-synced vault, and `.DS_Store` should never make a folder look occupied.
fn ensure_safe_to_adopt(target: &Path) -> Result<(), String> {
    let entries =
        std::fs::read_dir(target).map_err(|e| format!("Cannot read {}: {e}", target.display()))?;

    let mut visible = 0usize;
    let mut canonical = 0usize;
    let mut has_woodshed_dir = false;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Cannot read {}: {e}", target.display()))?;
        let raw_name = entry.file_name();
        let name = raw_name.to_string_lossy();

        if name == ".woodshed" {
            has_woodshed_dir = true;
            continue;
        }
        if name.starts_with('.') {
            continue;
        }
        visible += 1;
        if vault_lib::VAULT_SUBDIRS.contains(&name.as_ref()) && entry.path().is_dir() {
            canonical += 1;
        }
    }

    let empty = visible == 0;
    let looks_like_vault = has_woodshed_dir || canonical >= VAULT_RECOGNITION_THRESHOLD;
    if empty || looks_like_vault {
        return Ok(());
    }

    Err(format!(
        "{} has files in it but is not a Woodshed vault. Choose an empty folder \
         or an existing vault — Woodshed creates its own folders here and may \
         move files that match an older vault layout.",
        target.display()
    ))
}

/// Remove the derived search index so the next boot rebuilds from the new
/// vault. Sidecars are cleared too: the index runs in rollback-journal mode
/// today, but leaving a stale `-wal` behind if that ever changes would
/// resurrect the previous vault's rows.
fn discard_search_index(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    let db = crate::index::default_db_path(&app_data);
    for candidate in [
        db.clone(),
        db.with_extension("db-wal"),
        db.with_extension("db-shm"),
    ] {
        match std::fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("clear search index {}: {e}", candidate.display())),
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultGitSyncResult {
    pub branch: String,
    pub changed_paths: usize,
    pub pulled: bool,
    /// How many vault files the pull brought down (added/modified/renamed,
    /// excluding deletions). Zero when origin was already up to date.
    pub pulled_paths: usize,
    /// The relative paths of those pulled files, for display in the sync toast.
    pub pulled_files: Vec<String>,
    pub committed: bool,
    pub commit_message: Option<String>,
    pub pushed: bool,
    pub summary: String,
}

/// Pull the configured vault from GitHub, commit every current filesystem
/// change, then push the vault back to origin/main.
#[tauri::command]
pub async fn vault_git_sync(app: tauri::AppHandle) -> Result<VaultGitSyncResult, String> {
    let path = config::vault_path_get(app)?
        .ok_or_else(|| "No vault path is configured yet.".to_string())?;
    crate::log_info!("vault::git_sync", "start path={path}");
    let result =
        tauri::async_runtime::spawn_blocking(move || vault_git_sync_at(&PathBuf::from(path)))
            .await
            .map_err(|e| format!("vault git sync task failed: {e}"))?;
    match &result {
        Ok(result) => crate::log_info!(
            "vault::git_sync",
            "done branch={} pulled_paths={} changed_paths={} committed={} pushed={}",
            result.branch,
            result.pulled_paths,
            result.changed_paths,
            result.committed,
            result.pushed
        ),
        Err(err) => crate::log_error!("vault::git_sync", "{err}"),
    }
    result
}

pub fn vault_git_sync_at(vault: &Path) -> Result<VaultGitSyncResult, String> {
    if !vault.is_dir() {
        return Err(format!(
            "Vault path is not a directory: {}",
            vault.display()
        ));
    }

    let inside_work_tree = run_git(vault, &["rev-parse", "--is-inside-work-tree"])?;
    if inside_work_tree.trim() != "true" {
        return Err(format!(
            "Vault is not a git repository: {}",
            vault.display()
        ));
    }

    let branch = run_git(vault, &["branch", "--show-current"])?
        .trim()
        .to_string();
    if branch != VAULT_GIT_BRANCH {
        return Err(format!(
            "Vault git branch is '{branch}', expected '{VAULT_GIT_BRANCH}'."
        ));
    }

    // Snapshot HEAD around the pull so we can report which files origin
    // brought down (a fast-forward only moves HEAD; diffing the two tips
    // names exactly what changed).
    let head_before_pull = git_head(vault);
    run_git(
        vault,
        &["pull", "--ff-only", VAULT_GIT_REMOTE, VAULT_GIT_BRANCH],
    )?;
    let head_after_pull = git_head(vault);
    let pulled_files = match (&head_before_pull, &head_after_pull) {
        (Some(before), Some(after)) if before != after => git_pulled_files(vault, before, after),
        _ => Vec::new(),
    };
    let pulled_paths = pulled_files.len();

    run_git(vault, &["add", "-A"])?;

    let status = run_git(vault, &["status", "--porcelain"])?;
    let changed_paths = status
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();

    let commit_message = if changed_paths > 0 {
        let message = vault_commit_message();
        run_git(vault, &["commit", "-m", message.as_str()])?;
        Some(message)
    } else {
        None
    };

    run_git(
        vault,
        &[
            "push",
            VAULT_GIT_REMOTE,
            &format!("HEAD:{VAULT_GIT_BRANCH}"),
        ],
    )?;

    let summary = sync_summary(pulled_paths, changed_paths);

    Ok(VaultGitSyncResult {
        branch,
        changed_paths,
        pulled: true,
        pulled_paths,
        pulled_files,
        committed: commit_message.is_some(),
        commit_message,
        pushed: true,
        summary,
    })
}

/// Compose the one-line sync summary shown in the toast, folding in both the
/// pull (files arriving from origin) and the local commit/push.
fn sync_summary(pulled_paths: usize, changed_paths: usize) -> String {
    let pull_part = (pulled_paths > 0).then(|| {
        format!(
            "Pulled {} {} from {VAULT_GIT_BRANCH}",
            pulled_paths,
            if pulled_paths == 1 { "file" } else { "files" }
        )
    });
    let local_part = if changed_paths > 0 {
        format!(
            "committed {} changed {} and pushed {VAULT_GIT_BRANCH}",
            changed_paths,
            if changed_paths == 1 { "path" } else { "paths" }
        )
    } else if pull_part.is_some() {
        "no local changes to commit".to_string()
    } else {
        format!("No vault changes to commit; {VAULT_GIT_BRANCH} is up to date")
    };

    let combined = match pull_part {
        Some(pull) => format!("{pull}; {local_part}"),
        None => local_part,
    };
    format!("{}.", capitalize_first(&combined))
}

fn capitalize_first(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Resolve the current HEAD commit, or None when the repo has no commits yet
/// (or rev-parse otherwise fails — the caller treats that as "nothing pulled").
fn git_head(vault: &Path) -> Option<String> {
    run_git(vault, &["rev-parse", "HEAD"])
        .ok()
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
}

/// List the vault files a fast-forward pull brought in, excluding deletions
/// (`--diff-filter=d`) so the toast reports files now present in the vault.
fn git_pulled_files(vault: &Path, before: &str, after: &str) -> Vec<String> {
    let range = format!("{before}..{after}");
    match run_git(
        vault,
        &["diff", "--name-only", "--diff-filter=d", range.as_str()],
    ) {
        Ok(out) => out
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn vault_commit_message() -> String {
    format!(
        "Update Woodshed vault ({})",
        chrono::Local::now().format("%Y-%m-%d %H:%M")
    )
}

fn run_git(vault: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(vault)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "git is not installed or is not available on PATH.".to_string()
            } else {
                format!("run git {}: {e}", args.join(" "))
            }
        })?;

    if output.status.success() {
        return Ok(command_output(&output));
    }

    Err(format!(
        "git {} failed: {}",
        args.join(" "),
        output_text(&output)
    ))
}

fn command_output(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

fn output_text(output: &Output) -> String {
    let text = command_output(output);
    if text.is_empty() {
        "no output".to_string()
    } else {
        text
    }
}

#[tauri::command]
pub fn vault_is_icloud(path: String) -> bool {
    vault_lib::is_icloud_path(&PathBuf::from(path))
}

#[tauri::command]
pub fn vault_reveal(app: tauri::AppHandle) -> Result<(), String> {
    let path = config::vault_path_get(app)?
        .ok_or_else(|| "No vault path is configured yet.".to_string())?;
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(format!("Vault path is not a directory: {}", path.display()));
    }
    open_os_target(path.as_os_str())
}

#[tauri::command]
pub fn external_url_open(url: String) -> Result<(), String> {
    let parsed = validate_external_url(&url)?;
    open_os_target(OsStr::new(parsed.as_str()))
}

fn validate_external_url(url: &str) -> Result<reqwest::Url, String> {
    let url = url.trim();
    if url.len() > 8 * 1024 || url.chars().any(char::is_control) {
        return Err("External URL is too long or contains control characters".to_string());
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid external URL".to_string())?;
    match parsed.scheme() {
        "http" | "https"
            if parsed.host_str().is_some()
                && parsed.username().is_empty()
                && parsed.password().is_none() => {}
        "mailto" | "tel" if !parsed.path().trim().is_empty() => {}
        _ => return Err("Unsupported external URL scheme".to_string()),
    }
    Ok(parsed)
}

pub(crate) fn open_path(path: &Path) -> Result<(), String> {
    open_os_target(path.as_os_str())
}

fn open_os_target(target: &OsStr) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open target: {e}"))
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("xdg-open target: {e}"))
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer target: {e}"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = target;
        Err("opening OS targets is unsupported on this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command as ProcessCommand;
    use tempfile::TempDir;

    #[test]
    fn vault_init_scaffolds_subdirs() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("my-vault");
        vault_init(target.to_string_lossy().to_string(), false).unwrap();
        for sub in vault_lib::VAULT_SUBDIRS {
            assert!(target.join(sub).is_dir(), "missing subdir {}", sub);
        }
    }

    #[test]
    fn vault_init_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("vault").to_string_lossy().to_string();
        vault_init(path.clone(), false).unwrap();
        vault_init(path.clone(), false).unwrap();
        // No error means idempotent.
    }

    #[test]
    fn vault_init_seeds_samples_when_requested() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("vault");
        vault_init(target.to_string_lossy().to_string(), true).unwrap();
        // Seeded directories should be non-empty.
        let people = std::fs::read_dir(target.join("people")).unwrap().count();
        assert!(people > 0, "expected seeded people files");
        let events = std::fs::read_dir(target.join(crate::vault::CADENCE_DIR))
            .unwrap()
            .count();
        assert!(events > 0, "expected seeded event files");
    }

    #[test]
    fn vault_init_skips_seed_when_flag_off() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("vault");
        vault_init(target.to_string_lossy().to_string(), false).unwrap();
        let people = std::fs::read_dir(target.join("people")).unwrap().count();
        assert_eq!(
            people, 0,
            "expected no seeded files when seed_samples=false"
        );
    }

    #[test]
    fn switch_target_accepts_a_different_existing_folder() {
        let tmp = TempDir::new().unwrap();
        let current = tmp.path().join("old");
        let next = tmp.path().join("new");
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&next).unwrap();

        let resolved =
            resolve_switch_target(next.to_str().unwrap(), Some(current.to_str().unwrap())).unwrap();
        assert_eq!(resolved, next.canonicalize().unwrap());
    }

    #[test]
    fn switch_target_accepts_any_folder_when_none_is_configured() {
        let tmp = TempDir::new().unwrap();
        let next = tmp.path().join("first-vault");
        fs::create_dir_all(&next).unwrap();

        assert!(resolve_switch_target(next.to_str().unwrap(), None).is_ok());
    }

    #[test]
    fn switch_target_rejects_the_current_vault() {
        let tmp = TempDir::new().unwrap();
        let current = tmp.path().join("vault");
        fs::create_dir_all(&current).unwrap();
        let current_str = current.to_str().unwrap();

        // Spelled the same, with a trailing slash, and via `..` — all three are
        // the configured vault and must not cause a restart.
        for spelling in [
            current_str.to_string(),
            format!("{current_str}/"),
            format!("{current_str}/../vault"),
        ] {
            let err = resolve_switch_target(&spelling, Some(current_str)).unwrap_err();
            assert!(
                err.contains("already your vault"),
                "spelling {spelling:?} gave: {err}"
            );
        }
    }

    #[test]
    fn switch_target_rejects_blank_missing_and_non_directory_paths() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("notes.md");
        fs::write(&file, "not a vault\n").unwrap();
        let missing = tmp.path().join("does-not-exist");

        assert!(resolve_switch_target("   ", None)
            .unwrap_err()
            .contains("Choose a folder"));
        assert!(resolve_switch_target(missing.to_str().unwrap(), None)
            .unwrap_err()
            .contains("Cannot open"));
        assert!(resolve_switch_target(file.to_str().unwrap(), None)
            .unwrap_err()
            .contains("is not a folder"));
    }

    #[test]
    fn adopting_accepts_an_empty_folder() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("fresh");
        fs::create_dir_all(&dir).unwrap();
        assert!(ensure_safe_to_adopt(&dir).is_ok());
    }

    #[test]
    fn adopting_ignores_dotfiles_when_judging_emptiness() {
        // A git-synced vault has `.git`; macOS scatters `.DS_Store`. Neither
        // makes a folder "occupied" for this purpose.
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("dotfiles-only");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".DS_Store"), "").unwrap();
        assert!(ensure_safe_to_adopt(&dir).is_ok());
    }

    #[test]
    fn adopting_accepts_a_populated_vault() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("vault");
        vault_lib::ensure_dirs(&dir).unwrap();
        fs::write(dir.join("notebook").join("n.md"), "---\ntype: note\n---\n").unwrap();
        assert!(ensure_safe_to_adopt(&dir).is_ok());
    }

    #[test]
    fn adopting_accepts_a_vault_identified_only_by_its_woodshed_dir() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("sparse-vault");
        fs::create_dir_all(dir.join(".woodshed")).unwrap();
        fs::write(dir.join("stray.md"), "notes\n").unwrap();
        assert!(ensure_safe_to_adopt(&dir).is_ok());
    }

    #[test]
    fn adopting_rejects_someone_elses_documents() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("documents");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("taxes.pdf"), "x").unwrap();
        fs::write(dir.join("notes.md"), "x").unwrap();

        let err = ensure_safe_to_adopt(&dir).unwrap_err();
        assert!(err.contains("not a Woodshed vault"), "got: {err}");
    }

    #[test]
    fn adopting_rejects_a_folder_the_migration_would_rearrange() {
        // The case this guard exists for. `calendar/` and `daily/` contents are
        // renamed into `cadence/` by the boot migration, and every `.md` under
        // `resources/` is rewritten. One incidental match must not be enough to
        // pass for a vault.
        for incidental in ["calendar", "daily", "resources"] {
            let tmp = TempDir::new().unwrap();
            let dir = tmp.path().join("not-a-vault");
            fs::create_dir_all(dir.join(incidental)).unwrap();
            fs::write(dir.join(incidental).join("mine.md"), "important\n").unwrap();
            fs::write(dir.join("readme.txt"), "x").unwrap();

            assert!(
                ensure_safe_to_adopt(&dir).is_err(),
                "folder containing only {incidental}/ was accepted as a vault"
            );
        }
    }

    #[test]
    fn switching_into_an_existing_vault_preserves_its_records() {
        // `vault_switch` scaffolds the destination with `ensure_dirs`. Pointing
        // at a folder that is already a populated vault must add the missing
        // canonical subdirs without touching anything already there.
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("existing-vault");
        fs::create_dir_all(target.join("notebook")).unwrap();
        let note = target.join("notebook").join("keep-me.md");
        fs::write(&note, "---\ntype: note\n---\n\noriginal\n").unwrap();

        let resolved = resolve_switch_target(target.to_str().unwrap(), None).unwrap();
        vault_lib::ensure_dirs(&resolved).unwrap();

        assert_eq!(
            fs::read_to_string(&note).unwrap(),
            "---\ntype: note\n---\n\noriginal\n",
            "existing record was modified by the switch"
        );
        for sub in vault_lib::VAULT_SUBDIRS {
            assert!(resolved.join(sub).is_dir(), "missing subdir {sub}");
        }
    }

    #[test]
    fn vault_git_sync_commits_and_pushes_changes() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let vault = make_git_vault(&tmp);

        fs::write(vault.join("note.md"), "new vault note\n").unwrap();
        let result = vault_git_sync_at(&vault).unwrap();

        assert_eq!(result.branch, "main");
        assert_eq!(result.changed_paths, 1);
        assert!(result.committed);
        assert!(result.pushed);
        assert!(result
            .commit_message
            .as_deref()
            .unwrap_or_default()
            .starts_with("Update Woodshed vault ("));
        assert!(run_git(&vault, &["status", "--porcelain"])
            .unwrap()
            .is_empty());
        assert!(run_git(&vault, &["log", "-1", "--format=%s"])
            .unwrap()
            .starts_with("Update Woodshed vault ("));
    }

    #[test]
    fn vault_git_sync_skips_commit_when_clean() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let vault = make_git_vault(&tmp);

        let result = vault_git_sync_at(&vault).unwrap();

        assert_eq!(result.changed_paths, 0);
        assert!(!result.committed);
        assert!(result.commit_message.is_none());
        assert!(result.summary.contains("No vault changes to commit"));
    }

    #[test]
    fn vault_git_sync_reports_pulled_files() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let vault = make_git_vault(&tmp);

        // A second clone of the same remote stands in for "another device"
        // pushing a new file, which the vault's next sync should pull down.
        let remote = tmp.path().join("remote.git");
        let other = tmp.path().join("other");
        run_test_git(
            tmp.path(),
            &[
                "clone",
                "-b",
                "main",
                remote.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        run_test_git(&other, &["config", "user.name", "Woodshed Other"]);
        run_test_git(&other, &["config", "user.email", "other@example.test"]);
        fs::write(other.join("notes-from-elsewhere.md"), "remote note\n").unwrap();
        run_test_git(&other, &["add", "-A"]);
        run_test_git(&other, &["commit", "-m", "Add note from elsewhere"]);
        run_test_git(&other, &["push", "origin", "HEAD:main"]);

        let result = vault_git_sync_at(&vault).unwrap();

        assert_eq!(result.pulled_paths, 1);
        assert_eq!(
            result.pulled_files,
            vec!["notes-from-elsewhere.md".to_string()]
        );
        assert!(
            result.summary.contains("Pulled 1 file from main"),
            "summary was: {}",
            result.summary
        );
        assert_eq!(result.changed_paths, 0);
    }

    #[test]
    fn sync_summary_folds_pull_and_local_changes() {
        assert_eq!(
            sync_summary(0, 0),
            "No vault changes to commit; main is up to date."
        );
        assert_eq!(
            sync_summary(0, 2),
            "Committed 2 changed paths and pushed main."
        );
        assert_eq!(
            sync_summary(1, 0),
            "Pulled 1 file from main; no local changes to commit."
        );
        assert_eq!(
            sync_summary(3, 1),
            "Pulled 3 files from main; committed 1 changed path and pushed main."
        );
    }

    #[test]
    fn vault_is_icloud_detects_mobile_documents() {
        assert!(vault_is_icloud(
            "/Users/foo/Library/Mobile Documents/com~apple~CloudDocs/woodshed".to_string()
        ));
        assert!(!vault_is_icloud("/Users/foo/woodshed".to_string()));
    }

    #[test]
    fn external_url_validation_allows_links_but_rejects_unsafe_forms() {
        assert!(validate_external_url("https://example.com/article").is_ok());
        assert!(validate_external_url("mailto:person@example.com").is_ok());
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:password@example.com/private",
            "https://example.com/\nnext",
            "mailto:",
        ] {
            assert!(
                validate_external_url(url).is_err(),
                "expected rejection: {url}"
            );
        }
    }

    fn git_available() -> bool {
        ProcessCommand::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn make_git_vault(tmp: &TempDir) -> PathBuf {
        let remote = tmp.path().join("remote.git");
        let vault = tmp.path().join("vault");
        run_test_git(tmp.path(), &["init", "--bare", remote.to_str().unwrap()]);
        run_test_git(
            tmp.path(),
            &["clone", remote.to_str().unwrap(), vault.to_str().unwrap()],
        );
        run_test_git(&vault, &["checkout", "-b", "main"]);
        run_test_git(&vault, &["config", "user.name", "Woodshed Test"]);
        run_test_git(&vault, &["config", "user.email", "woodshed@example.test"]);
        fs::write(vault.join("README.md"), "initial\n").unwrap();
        run_test_git(&vault, &["add", "-A"]);
        run_test_git(&vault, &["commit", "-m", "Initial vault"]);
        run_test_git(&vault, &["push", "-u", "origin", "main"]);
        vault
    }

    fn run_test_git(dir: &Path, args: &[&str]) {
        let output = ProcessCommand::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap_or_else(|e| panic!("run git {}: {e}", args.join(" ")));
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            output_text(&output)
        );
    }
}
