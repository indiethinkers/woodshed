// Task commands. Files at vault/tasks/<id>.md, filename = id for direct
// path lookup. IDs are `t_<title-slug>_<short-ulid>` so the filename
// itself is human-skimmable in Finder / git diffs while the trailing
// 8-char ULID suffix preserves lexicographic creation order and
// guarantees uniqueness.

use crate::parsers::{self, Task as ParsedTask, TaskStatus};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;
use ulid::Ulid;

// Cap the slug portion so a long task title doesn't blow out filenames.
// 40 chars covers the meaningful prefix of nearly every real task title.
const TASK_SLUG_MAX: usize = 40;
// Trailing entropy. Crockford base32 (32^8 ≈ 1.1 trillion) is plenty for
// per-vault collision avoidance without making the ID unreadable.
const TASK_ID_SUFFIX_LEN: usize = 8;

fn build_task_id(content: &str) -> String {
    // Use only the first non-empty line for the slug — task content can
    // be multi-line, but the headline is what users recognise.
    let first_line = content
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let slug = truncate_slug(&slugify(first_line), TASK_SLUG_MAX);
    let ulid_str = Ulid::new().to_string();
    let suffix = &ulid_str[ulid_str.len() - TASK_ID_SUFFIX_LEN..];
    if slug.is_empty() {
        format!("t_{}", suffix)
    } else {
        format!("t_{}_{}", slug, suffix)
    }
}

// Same shape as commands::events::slugify_title but without the
// "event"/"task" fallback so callers can decide what to do with empties.
fn slugify(input: &str) -> String {
    let lowered: String = input
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let mut out = String::with_capacity(lowered.len());
    let mut last_dash = true;
    for c in lowered.chars() {
        if c == '-' {
            if !last_dash {
                out.push('-');
                last_dash = true;
            }
        } else {
            out.push(c);
            last_dash = false;
        }
    }
    if out.ends_with('-') {
        out.pop();
    }
    out
}

// Truncate at a word boundary when reasonable (avoids cutting a word in
// half), otherwise fall back to a hard truncate at max_len.
fn truncate_slug(slug: &str, max_len: usize) -> String {
    if slug.len() <= max_len {
        return slug.to_string();
    }
    let head = &slug[..max_len];
    if let Some(last_dash) = head.rfind('-') {
        if last_dash >= max_len / 2 {
            return head[..last_dash].to_string();
        }
    }
    head.to_string()
}

const STORE_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub id: String,
    pub path: String, // vault-relative
    pub content: String,
    pub status: TaskStatus,
    pub area: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled: Option<String>,
    pub tags: Vec<String>,
    /// Total seconds the task has spent in the in-progress state.
    /// Always emitted; defaults to 0 for fresh tasks.
    pub time_spent_seconds: u64,
    /// ISO 8601 timestamp marking when the current timer run started.
    /// `None` when the task is not active or is active with a paused timer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_progress_started_at: Option<String>,
    /// Manual sort key for backlog ordering. Always emitted; defaults to the
    /// effective fallback the backend computes (created-time milliseconds) so
    /// the UI never has to handle a "missing" case.
    pub sort_key: f64,
    pub body: String,
}

impl TaskDto {
    pub(crate) fn from_parsed(task: ParsedTask, vault: &Path, abs_path: &Path) -> Self {
        let rel = abs_path
            .strip_prefix(vault)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| abs_path.to_string_lossy().to_string());
        let sort_key = task
            .sort_key
            .unwrap_or_else(|| created_fallback_sort_key(task.created.as_deref()));
        TaskDto {
            id: task.id,
            path: rel,
            content: task.content,
            status: task.status,
            area: task.area,
            created: task.created,
            scheduled: task.scheduled,
            tags: task.tags,
            time_spent_seconds: task.time_spent_seconds.unwrap_or(0),
            in_progress_started_at: task.in_progress_started_at,
            sort_key,
            body: task.body,
        }
    }
}

/// Fallback ordering for tasks that predate the manual sort_key field:
/// epoch milliseconds of the created timestamp. Tasks with no created
/// timestamp sort to 0 (effectively "oldest").
fn created_fallback_sort_key(created: Option<&str>) -> f64 {
    created
        .and_then(|c| chrono::DateTime::parse_from_rfc3339(c).ok())
        .map(|dt| dt.timestamp_millis() as f64)
        .unwrap_or(0.0)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdate {
    pub content: Option<String>,
    pub body: Option<String>,
    pub status: Option<TaskStatus>,
    pub area: Option<String>,
    pub scheduled: Option<Option<String>>, // distinguish "clear" from "leave alone"
    pub tags: Option<Vec<String>>,
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

fn task_path(vault: &Path, id: &str) -> Result<PathBuf, String> {
    vault_lib::record_file_path(vault, "tasks", id)
}

fn write_task(
    state: &State<AppState>,
    vault: &Path,
    abs_path: &Path,
    task: &ParsedTask,
) -> Result<(), String> {
    let serialized = parsers::serialize_task(task).map_err(|e| e.to_string())?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &serialized).map_err(|e| e.to_string())?;
    let _ = vault;
    Ok(())
}

fn index_task(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    abs_path: &Path,
    task: &ParsedTask,
) {
    if let Ok(idx) = state.ensure_index(app) {
        let rel = crate::index::rel_path_str(vault, abs_path);
        if let Err(e) = idx.upsert(&crate::index::doc_from_task(task, &rel)) {
            eprintln!("index task {}: {}", task.id, e);
        }
    }
}

fn unindex_task(app: &AppHandle, state: &State<AppState>, id: &str) {
    if let Ok(idx) = state.ensure_index(app) {
        let rel = format!("tasks/{}.md", id);
        if let Err(e) = idx.delete_by_path(&rel) {
            eprintln!("unindex task {}: {}", id, e);
        }
    }
}

fn read_task(vault: &Path, abs_path: &Path) -> Result<TaskDto, String> {
    let content = vault_lib::read_record(abs_path).map_err(|e| e.to_string())?;
    let parsed = parsers::parse_task(&content).map_err(|e| format!("{:#}", e))?;
    Ok(TaskDto::from_parsed(parsed, vault, abs_path))
}

fn write_and_index_task(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    path: &Path,
    task: &ParsedTask,
) -> Result<TaskDto, String> {
    write_task(state, vault, path, task)?;
    index_task(app, state, vault, path, task);
    Ok(TaskDto::from_parsed(task.clone(), vault, path))
}

#[tauri::command]
pub fn task_create(
    app: AppHandle,
    state: State<AppState>,
    content: String,
    area: String,
    scheduled: Option<String>,
) -> Result<TaskDto, String> {
    let vault = vault_root(&app)?;
    let id = build_task_id(&content);
    let path = task_path(&vault, &id)?;

    let now = chrono::Local::now();
    let task = ParsedTask {
        id: id.clone(),
        content,
        status: TaskStatus::Backlog,
        area,
        created: Some(now.to_rfc3339()),
        scheduled,
        tags: vec!["task".to_string()],
        time_spent_seconds: None,
        in_progress_started_at: None,
        // Seed with current epoch ms so freshly-created tasks naturally sit at
        // the bottom of the backlog list. Drag-reorder rewrites this later.
        sort_key: Some(now.timestamp_millis() as f64),
        body: String::new(),
    };

    write_and_index_task(&app, &state, &vault, &path, &task)
}

#[tauri::command]
pub fn task_get(app: AppHandle, id: String) -> Result<Option<TaskDto>, String> {
    let vault = vault_root(&app)?;
    let path = task_path(&vault, &id)?;
    if path.exists() {
        return read_task(&vault, &path).map(Some);
    }
    // Filename-based lookup missed. Fall back to scanning tasks/ by
    // frontmatter id — `tasks_for_date` uses the same scan and is
    // working, so if the file is on disk with this id we'll find it.
    // The mismatch usually means the id-from-URL doesn't equal the
    // on-disk filename (e.g., a stale URL after the id-format change
    // that switched from `t_<ULID>` to `t_<slug>_<short>`).
    let dir = vault_lib::collection_dir(&vault, "tasks");
    if !vault_lib::is_real_directory(&dir) {
        return Ok(None);
    }
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") || !vault_lib::is_real_file(&p) {
            continue;
        }
        if let Ok(task) = read_task(&vault, &p) {
            if task.id == id {
                eprintln!(
                    "task_get: filename lookup missed for id={}, found via scan at {}",
                    id,
                    p.display(),
                );
                return Ok(Some(task));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn task_update(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    update: TaskUpdate,
) -> Result<TaskDto, String> {
    let vault = vault_root(&app)?;
    let path = task_path(&vault, &id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut task = parsers::parse_task(&content).map_err(|e| format!("{:#}", e))?;

    if let Some(c) = update.content {
        task.content = c;
    }
    if let Some(b) = update.body {
        task.body = b;
    }
    if let Some(s) = update.status {
        apply_status_change(&mut task, s);
    }
    if let Some(sp) = update.area {
        task.area = sp;
    }
    if let Some(sched) = update.scheduled {
        task.scheduled = sched;
    }
    if let Some(t) = update.tags {
        task.tags = t;
    }

    write_and_index_task(&app, &state, &vault, &path, &task)
}

/// Apply a status transition to a task, maintaining the time-spent invariants:
///   - When entering in-progress (from any other state): record the start time.
///   - When leaving in-progress: add elapsed seconds to time_spent_seconds and
///     clear the start timestamp.
///   - Same status -> no-op (the rest of `task_update` short-circuits earlier
///     in practice, but this is defensive).
fn apply_status_change(task: &mut ParsedTask, new_status: TaskStatus) {
    let old_status = task.status;
    if old_status == new_status {
        return;
    }
    let was_in_progress = old_status == TaskStatus::InProgress;
    let is_in_progress = new_status == TaskStatus::InProgress;

    if was_in_progress {
        accumulate_running_time(task);
    }

    if is_in_progress {
        task.in_progress_started_at = Some(chrono::Local::now().to_rfc3339());
    }

    task.status = new_status;
}

fn accumulate_running_time(task: &mut ParsedTask) {
    if let Some(started_str) = task.in_progress_started_at.take() {
        if let Ok(started) = chrono::DateTime::parse_from_rfc3339(&started_str) {
            let now = chrono::Utc::now();
            let delta = now.signed_duration_since(started.with_timezone(&chrono::Utc));
            let secs = delta.num_seconds().max(0) as u64;
            let prev = task.time_spent_seconds.unwrap_or(0);
            task.time_spent_seconds = Some(prev.saturating_add(secs));
        }
    }
}

#[tauri::command]
pub fn task_timer_pause(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<TaskDto, String> {
    let vault = vault_root(&app)?;
    let path = task_path(&vault, &id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut task = parsers::parse_task(&content).map_err(|e| format!("{:#}", e))?;

    if task.status == TaskStatus::InProgress {
        accumulate_running_time(&mut task);
    }

    write_and_index_task(&app, &state, &vault, &path, &task)
}

#[tauri::command]
pub fn task_timer_resume(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<TaskDto, String> {
    let vault = vault_root(&app)?;
    let path = task_path(&vault, &id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut task = parsers::parse_task(&content).map_err(|e| format!("{:#}", e))?;

    if task.status != TaskStatus::InProgress {
        apply_status_change(&mut task, TaskStatus::InProgress);
    } else if task.in_progress_started_at.is_none() {
        task.in_progress_started_at = Some(chrono::Local::now().to_rfc3339());
    }

    write_and_index_task(&app, &state, &vault, &path, &task)
}

/// Set a task's manual sort_key. Used by drag-reorder in the sidebar; the
/// caller computes a midpoint between the dropped task's neighbors and
/// passes the resulting f64 here.
#[tauri::command]
pub fn task_reorder(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    sort_key: f64,
) -> Result<TaskDto, String> {
    let vault = vault_root(&app)?;
    let path = task_path(&vault, &id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut task = parsers::parse_task(&content).map_err(|e| format!("{:#}", e))?;
    task.sort_key = Some(sort_key);
    write_task(&state, &vault, &path, &task)?;
    index_task(&app, &state, &vault, &path, &task);
    Ok(TaskDto::from_parsed(task, &vault, &path))
}

#[tauri::command]
pub fn task_delete(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let path = task_path(&vault, &id)?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(&path);
    }
    if path.exists() {
        vault_lib::move_to_trash(&vault, &path)?;
    }
    unindex_task(&app, &state, &id);
    Ok(())
}

fn read_all_tasks(vault: &Path) -> Result<Vec<TaskDto>, String> {
    let dir = vault_lib::collection_dir(vault, "tasks");
    if !vault_lib::is_real_directory(&dir) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !vault_lib::is_real_file(&path)
        {
            continue;
        }
        match read_task(vault, &path) {
            Ok(t) => out.push(t),
            Err(e) => {
                // Skip corrupt files; surface in logs
                eprintln!("skipping {}: {}", path.display(), e);
            }
        }
    }
    Ok(out)
}

const STATUS_RANK: [TaskStatus; 3] = [
    TaskStatus::InProgress,
    TaskStatus::Backlog,
    TaskStatus::Done,
];

fn status_rank(s: TaskStatus) -> usize {
    STATUS_RANK.iter().position(|x| *x == s).unwrap_or(99)
}

#[tauri::command]
pub async fn tasks_for_date(app: AppHandle, date: String) -> Result<Vec<TaskDto>, String> {
    let vault = vault_root(&app)?;
    let mut tasks = read_all_tasks(&vault)?;
    tasks.retain(|t| t.scheduled.as_deref() == Some(date.as_str()));
    tasks.sort_by_key(|t| status_rank(t.status));
    Ok(tasks)
}

#[tauri::command]
pub async fn tasks_all(app: AppHandle) -> Result<Vec<TaskDto>, String> {
    let vault = vault_root(&app)?;
    let mut tasks = read_all_tasks(&vault)?;
    tasks.sort_by_key(|t| status_rank(t.status));
    Ok(tasks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VAULT_SUBDIRS;
    use tempfile::TempDir;

    #[test]
    fn task_id_includes_truncated_slug_and_short_suffix() {
        let id = build_task_id("Set up Perplexity search integration");
        // t_<slug-up-to-40>_<8-char-suffix>
        assert!(
            id.starts_with("t_set-up-perplexity-search-integration"),
            "got {}",
            id
        );
        let parts: Vec<&str> = id.rsplitn(2, '_').collect();
        // Last segment is the 8-char ULID suffix.
        assert_eq!(parts[0].len(), TASK_ID_SUFFIX_LEN);
    }

    #[test]
    fn task_id_falls_back_to_suffix_only_when_content_is_empty() {
        let id = build_task_id("");
        assert!(id.starts_with("t_"));
        assert_eq!(id.len(), 2 + TASK_ID_SUFFIX_LEN);
    }

    #[test]
    fn task_id_uses_only_first_nonempty_line_for_slug() {
        let id = build_task_id("\n\nFix the deploy script\nlong context goes here");
        assert!(id.starts_with("t_fix-the-deploy-script_"), "got {}", id);
    }

    #[test]
    fn slugify_strips_punctuation_and_collapses_dashes() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("[[Wiki link]] & symbols"), "wiki-link-symbols");
        assert_eq!(slugify("   "), "");
    }

    #[test]
    fn truncate_slug_cuts_at_word_boundary() {
        let slug = "set-up-perplexity-search-integration-for-research";
        let truncated = truncate_slug(slug, 40);
        assert!(truncated.len() <= 40);
        // Should end on a word, not mid-word.
        assert!(!truncated.ends_with('-'));
        assert_eq!(truncated, "set-up-perplexity-search-integration");
    }

    fn setup_vault() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        for sub in VAULT_SUBDIRS {
            std::fs::create_dir_all(vault.join(sub)).unwrap();
        }
        (tmp, vault)
    }

    fn create_task(vault: &Path, scheduled: Option<&str>, status: TaskStatus) -> String {
        let id = format!("t_{}", Ulid::new());
        let task = ParsedTask {
            id: id.clone(),
            content: "test task".to_string(),
            status,
            area: "woodshed".to_string(),
            created: Some("2026-04-25T10:00:00-04:00".to_string()),
            scheduled: scheduled.map(String::from),
            tags: vec!["task".to_string()],
            time_spent_seconds: None,
            in_progress_started_at: None,
            sort_key: None,
            body: String::new(),
        };
        let serialized = parsers::serialize_task(&task).unwrap();
        let path = task_path(vault, &id).unwrap();
        std::fs::write(&path, serialized).unwrap();
        id
    }

    #[test]
    fn read_all_tasks_finds_md_files() {
        let (_tmp, vault) = setup_vault();
        create_task(&vault, Some("2026-04-25"), TaskStatus::Backlog);
        create_task(&vault, Some("2026-04-25"), TaskStatus::Done);
        create_task(&vault, Some("2026-04-26"), TaskStatus::InProgress);

        let tasks = read_all_tasks(&vault).unwrap();
        assert_eq!(tasks.len(), 3);
    }

    #[test]
    fn read_all_tasks_skips_non_md_files() {
        let (_tmp, vault) = setup_vault();
        create_task(&vault, Some("2026-04-25"), TaskStatus::Backlog);
        std::fs::write(vault.join("tasks").join("not-a-task.txt"), "noise").unwrap();

        let tasks = read_all_tasks(&vault).unwrap();
        assert_eq!(tasks.len(), 1);
    }

    #[test]
    fn read_all_tasks_skips_corrupt_files() {
        let (_tmp, vault) = setup_vault();
        create_task(&vault, Some("2026-04-25"), TaskStatus::Backlog);
        std::fs::write(
            vault.join("tasks").join("corrupt.md"),
            "this is not valid frontmatter",
        )
        .unwrap();

        let tasks = read_all_tasks(&vault).unwrap();
        assert_eq!(tasks.len(), 1);
    }

    #[test]
    fn status_rank_orders_in_progress_first() {
        assert!(status_rank(TaskStatus::InProgress) < status_rank(TaskStatus::Backlog));
        assert!(status_rank(TaskStatus::Backlog) < status_rank(TaskStatus::Done));
    }

    #[test]
    fn task_dto_strips_vault_prefix() {
        let (_tmp, vault) = setup_vault();
        let id = create_task(&vault, Some("2026-04-25"), TaskStatus::Backlog);
        let path = task_path(&vault, &id).unwrap();
        let dto = read_task(&vault, &path).unwrap();
        assert_eq!(dto.path, format!("tasks/{}.md", id));
    }

    #[test]
    fn read_task_returns_full_dto() {
        let (_tmp, vault) = setup_vault();
        let id = create_task(&vault, Some("2026-04-25"), TaskStatus::InProgress);
        let dto = read_task(&vault, &task_path(&vault, &id).unwrap()).unwrap();
        assert_eq!(dto.status, TaskStatus::InProgress);
        assert_eq!(dto.area, "woodshed");
        assert_eq!(dto.scheduled, Some("2026-04-25".to_string()));
        assert_eq!(dto.time_spent_seconds, 0);
    }

    fn make_parsed(status: TaskStatus) -> ParsedTask {
        ParsedTask {
            id: "t_test".to_string(),
            content: "x".to_string(),
            status,
            area: "woodshed".to_string(),
            created: None,
            scheduled: None,
            tags: vec![],
            time_spent_seconds: None,
            in_progress_started_at: None,
            sort_key: None,
            body: String::new(),
        }
    }

    #[test]
    fn entering_in_progress_sets_started_timestamp() {
        let mut t = make_parsed(TaskStatus::Backlog);
        apply_status_change(&mut t, TaskStatus::InProgress);
        assert_eq!(t.status, TaskStatus::InProgress);
        assert!(t.in_progress_started_at.is_some());
        assert_eq!(t.time_spent_seconds, None);
    }

    #[test]
    fn leaving_in_progress_accumulates_time() {
        let mut t = make_parsed(TaskStatus::InProgress);
        // Pretend the task started 10 seconds ago.
        t.in_progress_started_at =
            Some((chrono::Utc::now() - chrono::Duration::seconds(10)).to_rfc3339());
        apply_status_change(&mut t, TaskStatus::Done);
        assert_eq!(t.status, TaskStatus::Done);
        assert!(t.in_progress_started_at.is_none());
        let secs = t.time_spent_seconds.expect("expected accumulation");
        assert!(
            (8..=12).contains(&secs),
            "expected ~10 seconds, got {}",
            secs
        );
    }

    #[test]
    fn reentering_in_progress_after_done_resets_timer() {
        let mut t = make_parsed(TaskStatus::Done);
        t.time_spent_seconds = Some(60);
        apply_status_change(&mut t, TaskStatus::InProgress);
        assert!(t.in_progress_started_at.is_some());
        // Existing accumulator is preserved across the new run.
        assert_eq!(t.time_spent_seconds, Some(60));
    }

    #[test]
    fn second_in_progress_run_adds_to_accumulator() {
        let mut t = make_parsed(TaskStatus::InProgress);
        t.in_progress_started_at =
            Some((chrono::Utc::now() - chrono::Duration::seconds(5)).to_rfc3339());
        t.time_spent_seconds = Some(30);
        apply_status_change(&mut t, TaskStatus::Backlog);
        let secs = t.time_spent_seconds.expect("expected total");
        assert!((33..=37).contains(&secs), "expected ~35, got {}", secs);
    }

    #[test]
    fn pausing_in_progress_accumulates_without_changing_status() {
        let mut t = make_parsed(TaskStatus::InProgress);
        t.in_progress_started_at =
            Some((chrono::Utc::now() - chrono::Duration::seconds(7)).to_rfc3339());
        accumulate_running_time(&mut t);
        assert_eq!(t.status, TaskStatus::InProgress);
        assert!(t.in_progress_started_at.is_none());
        let secs = t.time_spent_seconds.expect("expected paused total");
        assert!((5..=9).contains(&secs), "expected ~7, got {}", secs);
    }

    #[test]
    fn paused_in_progress_can_complete_without_extra_time() {
        let mut t = make_parsed(TaskStatus::InProgress);
        t.time_spent_seconds = Some(45);
        t.in_progress_started_at = None;
        apply_status_change(&mut t, TaskStatus::Done);
        assert_eq!(t.status, TaskStatus::Done);
        assert_eq!(t.time_spent_seconds, Some(45));
        assert!(t.in_progress_started_at.is_none());
    }

    #[test]
    fn backlog_to_done_skipping_in_progress_is_a_noop_for_timing() {
        let mut t = make_parsed(TaskStatus::Backlog);
        apply_status_change(&mut t, TaskStatus::Done);
        assert_eq!(t.status, TaskStatus::Done);
        assert_eq!(t.time_spent_seconds, None);
        assert!(t.in_progress_started_at.is_none());
    }
}
