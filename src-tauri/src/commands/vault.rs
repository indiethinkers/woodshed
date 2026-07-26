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
