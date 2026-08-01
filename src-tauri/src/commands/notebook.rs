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
use sha2::{Digest, Sha256};
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
    /// Existing Markdown outside Woodshed's managed notebook collection.
    pub external: bool,
    /// Original parent directory relative to the selected vault.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
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
        let managed_notebook = vault_lib::collection_dir(vault, "notebook");
        let external = !abs_path.starts_with(&managed_notebook);
        let folder = external.then(|| {
            abs_path
                .parent()
                .and_then(|parent| parent.strip_prefix(vault).ok())
                .map(|parent| {
                    let value = parent.to_string_lossy().to_string();
                    if value.is_empty() {
                        ".".to_string()
                    } else {
                        value
                    }
                })
                .unwrap_or_else(|| ".".to_string())
        });
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
            external,
            folder,
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

fn write_external_body(
    state: &State<AppState>,
    abs_path: &Path,
    original: &str,
    body: &str,
) -> Result<(), String> {
    let next = replace_markdown_body(original, body);
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &next).map_err(|e| e.to_string())
}

fn write_external_metadata(
    state: &State<AppState>,
    abs_path: &Path,
    original: &str,
    title: Option<&str>,
    area: Option<&Option<String>>,
    tags: Option<&[String]>,
    favorite: Option<bool>,
) -> Result<(), String> {
    let next = patch_markdown_frontmatter(original, title, area, tags, favorite)?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &next).map_err(|e| e.to_string())
}

fn frontmatter_parts(content: &str) -> Option<(&str, &str)> {
    let rest = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            let yaml = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return Some((yaml, body.trim_start_matches(['\r', '\n'])));
        }
        offset += line.len();
    }
    None
}

fn replace_markdown_body(original: &str, body: &str) -> String {
    if let Some((yaml, _)) = frontmatter_parts(original) {
        if body.is_empty() {
            format!("---\n{yaml}---\n")
        } else {
            format!("---\n{yaml}---\n\n{body}")
        }
    } else {
        body.to_string()
    }
}

fn patch_markdown_frontmatter(
    original: &str,
    title: Option<&str>,
    area: Option<&Option<String>>,
    tags: Option<&[String]>,
    favorite: Option<bool>,
) -> Result<String, String> {
    let (raw_yaml, body) = frontmatter_parts(original).unwrap_or(("", original));
    let mut map: serde_yaml::Mapping = if raw_yaml.trim().is_empty() {
        serde_yaml::Mapping::new()
    } else {
        serde_yaml::from_str(raw_yaml).map_err(|error| {
            format!("cannot update metadata because YAML frontmatter is invalid: {error}")
        })?
    };
    let key = |value: &str| serde_yaml::Value::String(value.to_string());
    if let Some(title) = title {
        map.insert(key("title"), key(title));
    }
    if let Some(area) = area {
        match area {
            Some(area) => {
                map.insert(key("area"), key(area));
            }
            None => {
                map.remove(key("area"));
                map.remove(key("space"));
            }
        }
    }
    if let Some(tags) = tags {
        map.insert(
            key("tags"),
            serde_yaml::Value::Sequence(tags.iter().map(|tag| key(tag)).collect()),
        );
    }
    if let Some(favorite) = favorite {
        if favorite {
            map.insert(key("favorite"), serde_yaml::Value::Bool(true));
        } else {
            map.remove(key("favorite"));
        }
    }
    let yaml = serde_yaml::to_string(&map).map_err(|error| error.to_string())?;
    if body.trim().is_empty() {
        Ok(format!("---\n{yaml}---\n"))
    } else {
        Ok(format!("---\n{yaml}---\n\n{}", body.trim()))
    }
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

fn unindex_note(app: &AppHandle, state: &State<AppState>, vault: &Path, path: &Path) {
    if let Ok(idx) = state.ensure_index(app) {
        let rel = path
            .strip_prefix(vault)
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string());
        if let Err(e) = idx.delete_by_path(&rel) {
            eprintln!("unindex note failed: {e}");
        }
    }
}

pub(crate) fn read_note(vault: &Path, abs_path: &Path) -> Result<NoteDto, String> {
    let content = vault_lib::read_record(abs_path).map_err(|e| e.to_string())?;
    let parsed = parse_note_at_path(vault, abs_path, &content)?;
    Ok(NoteDto::from_parsed(
        parsed,
        vault,
        abs_path,
        vault_lib::content_revision(&content),
    ))
}

pub(crate) fn parse_note_at_path(
    vault: &Path,
    abs_path: &Path,
    content: &str,
) -> Result<ParsedNote, String> {
    let external = vault_lib::is_imported_layout(vault)
        && !abs_path.starts_with(vault_lib::records_root(vault));
    if !external {
        return parsers::parse_note(content).map_err(|e| format!("{e:#}"));
    }

    use gray_matter::{engine::YAML, Matter};
    let parsed = Matter::<YAML>::new().parse(content);
    let map = parsed.data.as_ref().and_then(|data| data.as_hashmap().ok());
    let string_field = |name: &str| {
        map.as_ref()
            .and_then(|values| values.get(name))
            .and_then(|value| value.as_string().ok())
            .filter(|value| !value.trim().is_empty())
    };
    let body = if parsed.data.is_some() {
        parsed.content.trim().to_string()
    } else {
        content.trim().to_string()
    };
    let title = string_field("title")
        .or_else(|| markdown_heading(&body))
        .unwrap_or_else(|| title_from_path(abs_path));
    let rel = abs_path
        .strip_prefix(vault)
        .map_err(|_| "note path escapes configured vault".to_string())?;
    let id = format!("file-{}", short_path_hash(rel));
    let created = string_field("created").unwrap_or_else(|| file_time(abs_path));
    let area = string_field("area").or_else(|| string_field("space"));
    let tags = map
        .as_ref()
        .and_then(|values| values.get("tags"))
        .and_then(|value| value.as_vec().ok())
        .map(|items| {
            items
                .into_iter()
                .filter_map(|item| item.as_string().ok())
                .collect()
        })
        .unwrap_or_default();
    let favorite = map
        .as_ref()
        .and_then(|values| values.get("favorite"))
        .and_then(|value| value.as_bool().ok())
        .unwrap_or(false);
    Ok(ParsedNote {
        id,
        title,
        area,
        created,
        tags,
        favorite,
        body,
    })
}

fn markdown_heading(body: &str) -> Option<String> {
    body.lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(String::from)
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Untitled")
        .replace(['-', '_'], " ")
}

fn short_path_hash(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn file_time(path: &Path) -> String {
    let time = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().or_else(|_| metadata.modified()).ok())
        .unwrap_or(std::time::UNIX_EPOCH);
    chrono::DateTime::<chrono::Local>::from(time).to_rfc3339()
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
        collect_markdown_files(&vault_lib::collection_dir(vault, subdir), &mut files)?;
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
    std::fs::create_dir_all(vault_lib::collection_dir(&vault, "notebook"))
        .map_err(|e| e.to_string())?;

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
    let Some(path) = find_note_path(&vault, &id, None)? else {
        return Ok(None);
    };
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
    let path = find_note_path(&vault, &id, input.expected_path.as_deref())?
        .ok_or_else(|| format!("note not found: {id}"))?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut note = parse_note_at_path(&vault, &path, &content)?;
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
    if is_external_note_path(&vault, &path) {
        write_external_body(&state, &path, &content, &note.body)?;
    } else {
        write_note(&state, &path, &note)?;
    }
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
    let path = find_note_path(&vault, &id, input.expected_path.as_deref())?
        .ok_or_else(|| format!("note not found: {id}"))?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut note = parse_note_at_path(&vault, &path, &content)?;
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
    if is_external_note_path(&vault, &path) {
        write_external_metadata(&state, &path, &content, Some(&note.title), None, None, None)?;
    } else {
        write_note(&state, &path, &note)?;
    }
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
    let path = find_note_path(&vault, &id, input.expected_path.as_deref())?
        .ok_or_else(|| format!("note not found: {id}"))?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut note = parse_note_at_path(&vault, &path, &content)?;
    let area_update = input.area.clone();
    let tags_update = input.tags.clone();
    let favorite_update = input.favorite;
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
    if is_external_note_path(&vault, &path) {
        write_external_metadata(
            &state,
            &path,
            &content,
            None,
            area_update.as_ref(),
            tags_update.as_deref(),
            favorite_update,
        )?;
    } else {
        write_note(&state, &path, &note)?;
    }
    index_note(&app, &state, &vault, &path, &note);
    read_note(&vault, &path)
}

#[tauri::command]
pub fn note_delete(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let Some(path) = find_note_path(&vault, &id, None)? else {
        return Ok(());
    };
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
    unindex_note(&app, &state, &vault, &path);
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
    let dir = vault_lib::collection_dir(vault, "notebook");
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
    if vault_lib::is_imported_layout(vault) {
        for path in collect_external_markdown_files(vault)? {
            match read_note(vault, &path) {
                Ok(note) => out.push(note),
                Err(_) => eprintln!("skipping unreadable imported Markdown note"),
            }
        }
    }
    // Newest first — date-grouping in the list panel buckets by created day.
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

fn is_external_note_path(vault: &Path, path: &Path) -> bool {
    vault_lib::is_imported_layout(vault) && !path.starts_with(vault_lib::records_root(vault))
}

fn find_note_path(
    vault: &Path,
    id: &str,
    expected_path: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    if let Some(expected) = expected_path {
        let candidate = vault.join(expected);
        if vault_lib::is_real_file(&candidate)
            && candidate.extension().and_then(|value| value.to_str()) == Some("md")
        {
            let canonical_vault = vault.canonicalize().map_err(|error| error.to_string())?;
            let canonical = candidate
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if canonical.starts_with(&canonical_vault) {
                let note = read_note(vault, &candidate)?;
                if note.id == id {
                    return Ok(Some(candidate));
                }
            }
        }
        return Err("note path changed on disk; reload before saving".to_string());
    }
    let managed = note_path(vault, id)?;
    if vault_lib::is_real_file(&managed) {
        return Ok(Some(managed));
    }
    if !vault_lib::is_imported_layout(vault) {
        return Ok(None);
    }
    for path in collect_external_markdown_files(vault)? {
        if read_note(vault, &path)
            .map(|note| note.id == id)
            .unwrap_or(false)
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

pub(crate) fn collect_external_markdown_files(vault: &Path) -> Result<Vec<PathBuf>, String> {
    if !vault_lib::is_imported_layout(vault) {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    let mut stack = vec![vault.to_path_buf()];
    let managed = vault_lib::records_root(vault);
    let internal = vault.join(".woodshed");
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if dir == vault => return Err(error.to_string()),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 50_000 {
                return Err("vault contains too many entries to scan safely".to_string());
            }
            let path = entry.path();
            if path == managed
                || path == internal
                || entry.file_name().to_string_lossy().starts_with('.')
            {
                continue;
            }
            if vault_lib::is_real_directory(&path) {
                stack.push(path);
            } else if vault_lib::is_real_file(&path)
                && path.extension().and_then(|value| value.to_str()) == Some("md")
            {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
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

    #[test]
    fn imported_markdown_appears_as_path_backed_notebook_notes() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("existing");
        std::fs::create_dir_all(vault.join("Projects/Research")).unwrap();
        std::fs::write(
            vault.join("Projects/Research/launch-plan.md"),
            "# Launch plan\n\nKeep the original path.",
        )
        .unwrap();
        std::fs::write(
            vault.join("Projects/Research/typed-note.md"),
            "---\ntype: note\nid: native\ntitle: Typed external note\ncreated: 2026-01-02T10:00:00Z\ntags: []\n---\n\nExisting content.",
        )
        .unwrap();
        vault_lib::initialize_imported_layout(&vault).unwrap();
        write_sample_note(&vault, "native", "Native note", "2026-01-01T10:00:00Z");

        let notes = read_all_notes(&vault).unwrap();
        let imported = notes.iter().find(|note| note.external).unwrap();

        assert_eq!(imported.title, "Launch plan");
        assert_eq!(imported.path, "Projects/Research/launch-plan.md");
        assert_eq!(imported.folder.as_deref(), Some("Projects/Research"));
        assert!(imported.id.starts_with("file-"));
        let typed = notes
            .iter()
            .find(|note| note.path.ends_with("typed-note.md"))
            .unwrap();
        assert!(typed.id.starts_with("file-"));
        assert_ne!(typed.id, "native");
        assert!(notes
            .iter()
            .any(|note| note.id == "native" && !note.external));
    }

    #[test]
    fn external_metadata_updates_preserve_unknown_frontmatter() {
        let original = "---\nowner: example\ntags:\n  - old\n---\n\nOriginal body";

        let updated = patch_markdown_frontmatter(
            original,
            Some("Updated title"),
            None,
            Some(&["new".to_string()]),
            Some(true),
        )
        .unwrap();

        assert!(updated.contains("owner: example"));
        assert!(updated.contains("title: Updated title"));
        assert!(updated.contains("favorite: true"));
        assert!(updated.contains("- new"));
        assert!(updated.ends_with("Original body"));
    }

    #[test]
    fn external_body_updates_keep_frontmatter_verbatim() {
        let original = "---\nowner: example\n# keep this comment\n---\n\nOld body";
        assert_eq!(
            replace_markdown_body(original, "New body"),
            "---\nowner: example\n# keep this comment\n---\n\nNew body"
        );
    }
}
