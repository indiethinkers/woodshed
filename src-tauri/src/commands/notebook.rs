// Notebook commands. Files at vault/notebook/<id>.md, where id is slugged
// from the title on creation. Filename = id for direct path lookup. Sorted
// by `created` descending in the list view (newest first).

use crate::parsers::{self, Note as ParsedNote};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::wikilinks::{
    collect_markdown_files, creation_trace_text, labels_match, push_unique_label,
    replace_wikilink_labels, safe_wikilink_label, WIKILINK_REWRITE_DIRS,
};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub id: String,
    pub path: String, // vault-relative
    pub revision: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    pub created: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub body: String,
}

impl NoteDto {
    pub(crate) fn from_parsed(
        note: ParsedNote,
        vault: &Path,
        abs_path: &Path,
        revision: String,
    ) -> Self {
        let rel = abs_path
            .strip_prefix(vault)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| abs_path.to_string_lossy().to_string());
        NoteDto {
            id: note.id,
            path: rel,
            revision,
            title: note.title,
            area: note.area,
            created: note.created,
            tags: note.tags,
            favorite: note.favorite,
            body: note.body,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreate {
    pub title: String,
    #[serde(default)]
    pub area: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteBodyUpdate {
    pub body: String,
    pub base_revision: String,
    #[serde(default)]
    pub expected_path: Option<String>,
    #[serde(default)]
    pub expected_created: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTitleUpdate {
    pub title: String,
    #[serde(default)]
    pub expected_path: Option<String>,
    #[serde(default)]
    pub expected_created: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetadataUpdate {
    // Double-Option lets the frontend distinguish "leave alone" (key absent)
    // from "clear" (explicit null).
    #[serde(default, deserialize_with = "nullable_string_field")]
    pub area: Option<Option<String>>,
    pub tags: Option<Vec<String>>,
    pub favorite: Option<bool>,
    #[serde(default)]
    pub expected_path: Option<String>,
    #[serde(default)]
    pub expected_created: Option<String>,
}

fn nullable_string_field<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

pub(crate) fn note_path(vault: &Path, id: &str) -> Result<PathBuf, String> {
    vault_lib::record_file_path(vault, "notebook", id)
}

/// Slugify a title into a filesystem-safe id. Lowercases, collapses
/// non-alphanumeric runs into single dashes, trims edges. Empty titles
/// fall back to "note".
fn slugify_title(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_dash = true;
    for c in title.chars() {
        if c.is_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    if out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "note".to_string()
    } else {
        out
    }
}

fn unique_id(vault: &Path, base: &str) -> Result<String, String> {
    if !note_path(vault, base)?.exists() {
        return Ok(base.to_string());
    }
    for n in 2..1000 {
        let candidate = format!("{}-{}", base, n);
        if !note_path(vault, &candidate)?.exists() {
            return Ok(candidate);
        }
    }
    Ok(format!(
        "{}-{}",
        base,
        chrono::Utc::now().timestamp_millis()
    ))
}

fn write_note(state: &State<AppState>, abs_path: &Path, note: &ParsedNote) -> Result<(), String> {
    let serialized = parsers::serialize_note(note).map_err(|e| e.to_string())?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &serialized).map_err(|e| e.to_string())
}

fn index_note(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    abs_path: &Path,
    note: &ParsedNote,
) {
    if let Ok(idx) = state.ensure_index(app) {
        let rel = crate::index::rel_path_str(vault, abs_path);
        if let Err(e) = idx.upsert(&crate::index::doc_from_note(note, &rel)) {
            eprintln!("index note {}: {}", note.id, e);
        }
    }
}

fn unindex_note(app: &AppHandle, state: &State<AppState>, id: &str) {
    if let Ok(idx) = state.ensure_index(app) {
        let rel = format!("notebook/{}.md", id);
        if let Err(e) = idx.delete_by_path(&rel) {
            eprintln!("unindex note {}: {}", id, e);
        }
    }
}

pub(crate) fn read_note(vault: &Path, abs_path: &Path) -> Result<NoteDto, String> {
    let content = vault_lib::read_record(abs_path).map_err(|e| e.to_string())?;
    let parsed = parsers::parse_note(&content).map_err(|e| format!("{:#}", e))?;
    Ok(NoteDto::from_parsed(
        parsed,
        vault,
        abs_path,
        vault_lib::content_revision(&content),
    ))
}

fn validate_note_identity(
    vault: &Path,
    abs_path: &Path,
    note: &ParsedNote,
    expected_id: &str,
    expected_path: Option<&str>,
    expected_created: Option<&str>,
) -> Result<(), String> {
    if note.id != expected_id {
        return Err(format!(
            "note identity mismatch: expected id {expected_id}, found {}",
            note.id
        ));
    }
    if let Some(expected) = expected_path {
        let rel = abs_path
            .strip_prefix(vault)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| abs_path.to_string_lossy().to_string());
        if rel != expected {
            return Err(format!(
                "note path changed on disk: expected {expected}, found {rel}"
            ));
        }
    }
    if let Some(expected) = expected_created {
        if note.created != expected {
            return Err("note identity mismatch: created timestamp changed".to_string());
        }
    }
    Ok(())
}

fn wikilink_label_for_note(note: &ParsedNote) -> String {
    safe_wikilink_label(&note.title, &note.id)
}

fn rewrite_note_backlinks_after_title_change(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    note: &ParsedNote,
    old_title: &str,
    old_id: &str,
) -> Result<usize, String> {
    let new_label = wikilink_label_for_note(note);
    let mut old_labels = Vec::new();
    push_unique_label(&mut old_labels, old_title);
    push_unique_label(&mut old_labels, old_id);
    push_unique_label(&mut old_labels, &note.id);
    old_labels.retain(|label| !labels_match(label, &new_label));
    if old_labels.is_empty() {
        return Ok(0);
    }

    let mut files = Vec::new();
    for subdir in WIKILINK_REWRITE_DIRS {
        collect_markdown_files(&vault.join(subdir), &mut files)?;
    }

    let mut changed = 0usize;
    for path in files {
        let raw = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
        let Some(next) = replace_wikilink_labels(&raw, &old_labels, &new_label) else {
            continue;
        };
        if let Some(watcher) = state.watcher.lock_recover().as_ref() {
            watcher.record_self_write(&path);
        }
        vault_lib::write_atomic(&path, &next).map_err(|e| e.to_string())?;
        if let Ok(idx) = state.ensure_index(app) {
            if let Err(e) = idx.refresh_path(vault, &path) {
                eprintln!("refresh note backlinks {}: {}", path.display(), e);
            }
        }
        changed += 1;
    }
    Ok(changed)
}

#[tauri::command]
pub fn note_create(
    app: AppHandle,
    state: State<AppState>,
    input: NoteCreate,
) -> Result<NoteDto, String> {
    let vault = vault_root(&app)?;
    std::fs::create_dir_all(vault.join("notebook")).map_err(|e| e.to_string())?;

    let id = unique_id(&vault, &slugify_title(&input.title))?;
    let path = note_path(&vault, &id)?;

    let note = ParsedNote {
        id: id.clone(),
        title: input.title,
        area: input.area,
        created: chrono::Local::now().to_rfc3339(),
        tags: input.tags,
        favorite: false,
        body: input.body.unwrap_or_default(),
    };

    write_note(&state, &path, &note)?;
    index_note(&app, &state, &vault, &path, &note);
    // Leave a bare wikilink trace on today's Cadence page. Non-fatal: the note
    // itself is already on disk, so a journal hiccup shouldn't fail the create.
    let trace_text = creation_trace_text(&wikilink_label_for_note(&note));
    if let Err(e) = crate::commands::daily::log_line_on_today(
        &app,
        &state,
        &vault,
        &trace_text,
        &[&note.id, &note.title],
    ) {
        eprintln!("daily log for note {}: {}", note.id, e);
    }
    read_note(&vault, &path)
}

#[tauri::command]
pub fn note_get(app: AppHandle, id: String) -> Result<Option<NoteDto>, String> {
    let vault = vault_root(&app)?;
    let path = note_path(&vault, &id)?;
    if !path.exists() {
        return Ok(None);
    }
    read_note(&vault, &path).map(Some)
}

#[tauri::command]
pub fn note_update_body(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: NoteBodyUpdate,
) -> Result<NoteDto, String> {
    let vault = vault_root(&app)?;
    let path = note_path(&vault, &id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut note = parsers::parse_note(&content).map_err(|e| format!("{:#}", e))?;
    validate_note_identity(
        &vault,
        &path,
        &note,
        &id,
        input.expected_path.as_deref(),
        input.expected_created.as_deref(),
    )?;
    let current_revision = vault_lib::content_revision(&content);
    if input.base_revision != current_revision {
        return Err("note changed on disk; reload before saving".to_string());
    }
    if input.body == note.body {
        return read_note(&vault, &path);
    }
    note.body = input.body;
    write_note(&state, &path, &note)?;
    index_note(&app, &state, &vault, &path, &note);
    read_note(&vault, &path)
}

#[tauri::command]
pub fn note_update_title(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: NoteTitleUpdate,
) -> Result<NoteDto, String> {
    let vault = vault_root(&app)?;
    let path = note_path(&vault, &id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut note = parsers::parse_note(&content).map_err(|e| format!("{:#}", e))?;
    validate_note_identity(
        &vault,
        &path,
        &note,
        &id,
        input.expected_path.as_deref(),
        input.expected_created.as_deref(),
    )?;
    let next = input.title.trim();
    if next.is_empty() {
        return read_note(&vault, &path);
    }
    let old_title = note.title.clone();
    let title_changed = !labels_match(&note.title, next);
    if !title_changed {
        return read_note(&vault, &path);
    }
    note.title = next.to_string();
    write_note(&state, &path, &note)?;
    index_note(&app, &state, &vault, &path, &note);
    rewrite_note_backlinks_after_title_change(&app, &state, &vault, &note, &old_title, &id)?;
    read_note(&vault, &path)
}

#[tauri::command]
pub fn note_update_metadata(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    input: NoteMetadataUpdate,
) -> Result<NoteDto, String> {
    let vault = vault_root(&app)?;
    let path = note_path(&vault, &id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut note = parsers::parse_note(&content).map_err(|e| format!("{:#}", e))?;
    validate_note_identity(
        &vault,
        &path,
        &note,
        &id,
        input.expected_path.as_deref(),
        input.expected_created.as_deref(),
    )?;
    if let Some(area) = input.area {
        note.area = area;
    }
    if let Some(tags) = input.tags {
        note.tags = tags;
    }
    if let Some(favorite) = input.favorite {
        note.favorite = favorite;
    }
    write_note(&state, &path, &note)?;
    index_note(&app, &state, &vault, &path, &note);
    read_note(&vault, &path)
}

#[tauri::command]
pub fn note_delete(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let path = note_path(&vault, &id)?;
    // Capture the labels its creation trace was logged under *before* the file
    // is gone, so we can scrub that backlink from the day's journal.
    let mut labels = vec![id.clone()];
    if let Ok(note) = read_note(&vault, &path) {
        push_unique_label(&mut labels, &safe_wikilink_label(&note.title, &note.id));
    }
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(&path);
    }
    if path.exists() {
        vault_lib::snapshot_existing_file(&path, None).map_err(|e| e.to_string())?;
        vault_lib::move_to_trash(&vault, &path)?;
    }
    unindex_note(&app, &state, &id);
    if let Err(e) = crate::wikilinks::remove_record_backlinks(&app, &state, &vault, &labels) {
        eprintln!("scrub backlinks for note {}: {}", id, e);
    }
    Ok(())
}

#[tauri::command]
pub async fn notes_all(app: AppHandle) -> Result<Vec<NoteDto>, String> {
    let vault = vault_root(&app)?;
    read_all_notes(&vault)
}

pub(crate) fn read_all_notes(vault: &Path) -> Result<Vec<NoteDto>, String> {
    let dir = vault.join("notebook");
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
        match read_note(vault, &path) {
            Ok(n) => out.push(n),
            Err(e) => eprintln!("skipping {}: {}", path.display(), e),
        }
    }
    // Newest first — date-grouping in the list panel buckets by created day.
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VAULT_SUBDIRS;
    use tempfile::TempDir;

    fn setup_vault() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        for sub in VAULT_SUBDIRS {
            std::fs::create_dir_all(vault.join(sub)).unwrap();
        }
        (tmp, vault)
    }

    fn write_sample_note(vault: &Path, id: &str, title: &str, created: &str) -> PathBuf {
        let note = ParsedNote {
            id: id.to_string(),
            title: title.to_string(),
            area: Some("woodshed".to_string()),
            created: created.to_string(),
            tags: vec![],
            favorite: false,
            body: "x".to_string(),
        };
        let path = note_path(vault, id).unwrap();
        let serialized = parsers::serialize_note(&note).unwrap();
        std::fs::write(&path, serialized).unwrap();
        path
    }

    #[test]
    fn slugify_title_collapses_punctuation() {
        assert_eq!(
            slugify_title("File-over-app philosophy"),
            "file-over-app-philosophy"
        );
        assert_eq!(slugify_title("What if?!"), "what-if");
        assert_eq!(
            slugify_title("[[wikilinks]] are great"),
            "wikilinks-are-great"
        );
    }

    #[test]
    fn slugify_empty_falls_back() {
        assert_eq!(slugify_title(""), "note");
        assert_eq!(slugify_title("###"), "note");
    }

    #[test]
    fn unique_id_appends_2_3_on_collision() {
        let (_tmp, vault) = setup_vault();
        write_sample_note(&vault, "thoughts", "Thoughts", "2026-04-25T10:00:00");
        assert_eq!(unique_id(&vault, "thoughts").unwrap(), "thoughts-2");
        write_sample_note(
            &vault,
            "thoughts-2",
            "Thoughts again",
            "2026-04-25T10:00:00",
        );
        assert_eq!(unique_id(&vault, "thoughts").unwrap(), "thoughts-3");
    }

    #[test]
    fn read_all_notes_sorts_newest_first() {
        let (_tmp, vault) = setup_vault();
        write_sample_note(&vault, "old", "Old", "2026-01-01T10:00:00");
        write_sample_note(&vault, "new", "New", "2026-04-25T10:00:00");
        write_sample_note(&vault, "mid", "Mid", "2026-03-15T10:00:00");

        let notes = read_all_notes(&vault).unwrap();
        let ids: Vec<_> = notes.iter().map(|n| n.id.clone()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    #[test]
    fn read_all_notes_skips_non_md_files() {
        let (_tmp, vault) = setup_vault();
        write_sample_note(&vault, "thought", "Thought", "2026-04-25T10:00:00");
        std::fs::write(vault.join("notebook").join("not-a-note.txt"), "noise").unwrap();
        assert_eq!(read_all_notes(&vault).unwrap().len(), 1);
    }

    #[test]
    fn read_all_notes_skips_corrupt_files() {
        let (_tmp, vault) = setup_vault();
        write_sample_note(&vault, "thought", "Thought", "2026-04-25T10:00:00");
        std::fs::write(
            vault.join("notebook").join("corrupt.md"),
            "this is not valid frontmatter",
        )
        .unwrap();
        assert_eq!(read_all_notes(&vault).unwrap().len(), 1);
    }

    #[test]
    fn read_all_notes_returns_empty_when_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        assert!(read_all_notes(&vault).unwrap().is_empty());
    }
}
