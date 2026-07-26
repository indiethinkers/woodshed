// People commands. Files at vault/people/<id>.md, filename = id (slugged
// from the name on creation; e.g. "Alex Rivera" → "alex-rivera.md").

use crate::parsers::{self, Person as ParsedPerson};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::wikilinks::{creation_trace_text, safe_wikilink_label};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonDto {
    pub id: String,
    pub path: String, // vault-relative
    pub name: String,
    pub initials: String,
    pub role: String,
    pub company: String,
    pub email: String,
    /// Free-text relationship note ("college friend", "Acme PM"),
    /// maintained manually by the user. Empty when unset.
    pub relationship: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Creation time (RFC 3339). Prefers the `created:` frontmatter once pinned;
    /// otherwise falls back to the file's birth time. Absent only if neither is
    /// available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    /// Last-modified time (RFC 3339), read from the file's modified time — the
    /// same "Date Modified" Finder shows. Purely derived; updates on every write.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    pub favorite: bool,
    pub body: String,
}

impl PersonDto {
    pub(crate) fn from_parsed(person: ParsedPerson, vault: &Path, abs_path: &Path) -> Self {
        let rel = abs_path
            .strip_prefix(vault)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| abs_path.to_string_lossy().to_string());
        // One stat for both timestamps. `created` prefers the pinned frontmatter
        // value, falling back to the file's birth time so the column works
        // before any edit pins it; `updated` is always the file's modified time.
        let fs_meta = std::fs::metadata(abs_path).ok();
        let created = person.created.or_else(|| {
            fs_meta
                .as_ref()
                .and_then(|m| m.created().or_else(|_| m.modified()).ok())
                .map(system_time_to_rfc3339)
        });
        let updated = fs_meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(system_time_to_rfc3339);
        PersonDto {
            id: person.id,
            path: rel,
            name: person.name,
            initials: person.initials,
            role: person.role,
            company: person.company,
            email: person.email,
            relationship: person.relationship,
            area: person.area,
            avatar: resolve_avatar_for_dto(vault, person.avatar),
            created,
            updated,
            favorite: person.favorite,
            body: person.body,
        }
    }
}

fn system_time_to_rfc3339(time: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Local>::from(time).to_rfc3339()
}

/// Read a file's creation (birth) time as an RFC 3339 string, falling back to
/// its modified time when the platform doesn't expose a birth time (e.g. some
/// Linux filesystems). macOS/APFS — Woodshed's target — always has a birth time.
fn file_created_rfc3339(abs_path: &Path) -> Option<String> {
    let meta = std::fs::metadata(abs_path).ok()?;
    let time = meta.created().or_else(|_| meta.modified()).ok()?;
    Some(system_time_to_rfc3339(time))
}

/// Expand the avatar field for transport to the frontend.
///
/// The supported persisted form is
/// `attachments/people/<id>-<suffix>.jpg`, a vault-managed file.
///
/// Legacy bundled paths, hand-edited URLs, data URIs, absolute paths, missing
/// files, and path escapes are deliberately omitted. That prevents a person
/// record from becoming an automatic tracking request or a way to probe
/// arbitrary local files through Tauri's asset protocol.
fn resolve_avatar_for_dto(vault: &Path, raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let relative = Path::new(trimmed);
    let managed_prefix = Path::new("attachments").join("people");
    if relative.is_absolute() || !relative.starts_with(&managed_prefix) {
        return None;
    }

    let attachments_dir = vault.join("attachments");
    let people_dir = vault.join(&managed_prefix);
    if !vault_lib::is_real_directory(&attachments_dir) || !vault_lib::is_real_directory(&people_dir)
    {
        return None;
    }
    let managed_dir = people_dir.canonicalize().ok()?;
    let unresolved = vault.join(relative);
    if !vault_lib::is_real_file(&unresolved) {
        return None;
    }
    let absolute = unresolved.canonicalize().ok()?;
    if absolute.parent()? != managed_dir {
        return None;
    }
    Some(absolute.to_string_lossy().to_string())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonCreate {
    pub name: String,
    pub role: String,
    pub company: String,
    pub email: String,
    #[serde(default)]
    pub relationship: String,
    #[serde(default)]
    pub area: Option<String>,
    #[serde(default)]
    pub initials: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonUpdate {
    pub name: Option<String>,
    pub initials: Option<String>,
    pub role: Option<String>,
    pub company: Option<String>,
    pub email: Option<String>,
    pub relationship: Option<String>,
    // Double-Option matches the existing `avatar` pattern — outer `None`
    // means "leave alone", `Some(None)` clears, `Some(Some(x))` sets.
    pub area: Option<Option<String>>,
    pub avatar: Option<Option<String>>,
    pub favorite: Option<bool>,
    pub body: Option<String>,
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

pub(crate) fn person_path(vault: &Path, id: &str) -> Result<PathBuf, String> {
    vault_lib::record_file_path(vault, "people", id)
}

/// Slugify a name into a filesystem-safe id. Lowercases, replaces non-
/// alphanumeric runs with single dashes, trims leading/trailing dashes.
fn slugify_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = true;
    for c in name.chars() {
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
        "person".to_string()
    } else {
        out
    }
}

/// Resolve a slug to an unused id, appending `-2`, `-3`, ... on collision.
fn unique_id(vault: &Path, base: &str) -> Result<String, String> {
    if !person_path(vault, base)?.exists() {
        return Ok(base.to_string());
    }
    for n in 2..1000 {
        let candidate = format!("{}-{}", base, n);
        if !person_path(vault, &candidate)?.exists() {
            return Ok(candidate);
        }
    }
    // Pathological collision count — defer to a timestamp suffix.
    Ok(format!(
        "{}-{}",
        base,
        chrono::Utc::now().timestamp_millis()
    ))
}

/// Compute initials from a name: take the first character of each word,
/// uppercase, max 2 characters. "Alex Rivera" → "AR", "Sam" → "S".
fn initials_from_name(name: &str) -> String {
    name.split_whitespace()
        .filter_map(|w| w.chars().next())
        .map(|c| c.to_ascii_uppercase())
        .take(2)
        .collect()
}

fn write_person(
    state: &State<AppState>,
    abs_path: &Path,
    person: &mut ParsedPerson,
) -> Result<(), String> {
    // Pin a `created` timestamp before we write. New records arrive with one
    // already set; legacy records (no `created:` frontmatter) get backfilled
    // from the existing file's birth time here — captured *before* the atomic
    // temp+rename swaps the inode and resets that birth time. After this, the
    // creation date lives in the file and survives edits, copies, and syncs.
    if person.created.is_none() {
        person.created = file_created_rfc3339(abs_path);
    }
    let serialized = parsers::serialize_person(person).map_err(|e| e.to_string())?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &serialized).map_err(|e| e.to_string())
}

fn index_person(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    abs_path: &Path,
    person: &ParsedPerson,
) {
    if let Ok(idx) = state.ensure_index(app) {
        let rel = crate::index::rel_path_str(vault, abs_path);
        if let Err(e) = idx.upsert(&crate::index::doc_from_person(person, &rel)) {
            eprintln!("index person {}: {}", person.id, e);
        }
    }
}

fn unindex_person(app: &AppHandle, state: &State<AppState>, id: &str) {
    if let Ok(idx) = state.ensure_index(app) {
        let rel = format!("people/{}.md", id);
        if let Err(e) = idx.delete_by_path(&rel) {
            eprintln!("unindex person {}: {}", id, e);
        }
    }
}

pub(crate) fn read_person(vault: &Path, abs_path: &Path) -> Result<PersonDto, String> {
    let content = vault_lib::read_record(abs_path).map_err(|e| e.to_string())?;
    // `{:#}` walks anyhow's full error chain so the underlying serde reason
    // ("missing field `role`") makes it to the logs — `to_string()` only
    // shows the top context, which is rarely informative on its own.
    let parsed = parsers::parse_person(&content).map_err(|e| format!("{:#}", e))?;
    Ok(PersonDto::from_parsed(parsed, vault, abs_path))
}

#[tauri::command]
pub fn person_create(
    app: AppHandle,
    state: State<AppState>,
    input: PersonCreate,
) -> Result<PersonDto, String> {
    let vault = vault_root(&app)?;
    std::fs::create_dir_all(vault.join("people")).map_err(|e| e.to_string())?;

    let id = unique_id(&vault, &slugify_name(&input.name))?;
    let path = person_path(&vault, &id)?;

    let mut person = ParsedPerson {
        id: id.clone(),
        initials: input
            .initials
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| initials_from_name(&input.name)),
        name: input.name,
        role: input.role,
        company: input.company,
        email: input.email,
        relationship: input.relationship,
        area: input.area,
        avatar: input.avatar,
        created: Some(chrono::Local::now().to_rfc3339()),
        favorite: false,
        body: input.body.unwrap_or_default(),
    };

    write_person(&state, &path, &mut person)?;
    index_person(&app, &state, &vault, &path, &person);
    refresh_email_index(&state, &vault);
    // Leave a bare wikilink trace on today's Cadence page. Non-fatal: the
    // person file is already on disk, so a journal hiccup shouldn't fail the
    // create.
    let trace_text = creation_trace_text(&safe_wikilink_label(&person.name, &person.id));
    if let Err(e) = crate::commands::daily::log_line_on_today(
        &app,
        &state,
        &vault,
        &trace_text,
        &[&person.id, &person.name],
    ) {
        eprintln!("daily log for person {}: {}", person.id, e);
    }
    Ok(PersonDto::from_parsed(person, &vault, &path))
}

/// Pull the primary author name out of a raw byline. Strips a leading "By ",
/// keeps only the first name when the byline lists co-authors or a trailing
/// title ("Jane Doe and John Smith" / "Jane Doe, Senior Editor" → "Jane Doe"),
/// and collapses whitespace. Empty when nothing usable remains.
pub(crate) fn primary_author_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_by = match trimmed.get(..3) {
        Some(prefix) if prefix.eq_ignore_ascii_case("by ") => trimmed[3..].trim_start(),
        _ => trimmed,
    };
    // Peel everything from the earliest co-author / title separator onward.
    let mut primary = without_by;
    for sep in [",", " and ", " & ", ";", " with "] {
        if let Some((head, _)) = primary.split_once(sep) {
            primary = head;
        }
    }
    primary.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Lowercase + whitespace-collapsed form for case-insensitive name matching.
fn normalize_for_match(name: &str) -> String {
    name.split_whitespace()
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Find an existing person whose name (or id) matches `name`, ignoring case
/// and whitespace. Matches the id too so "alex-rivera" resolves "Alex Rivera".
pub(crate) fn find_person_id_by_name(vault: &Path, name: &str) -> Result<Option<String>, String> {
    let target = normalize_for_match(name);
    if target.is_empty() {
        return Ok(None);
    }
    for person in read_all_people(vault)? {
        if normalize_for_match(&person.name) == target
            || normalize_for_match(&person.id.replace('-', " ")) == target
        {
            return Ok(Some(person.id));
        }
    }
    Ok(None)
}

/// Resolve a captured byline to a person id, creating a minimal person record
/// when none matches. Lets resource capture turn an article's author into a
/// linkable node in the vault. Returns `None` for an empty byline (the caller
/// then stores no author).
pub(crate) fn resolve_or_create_author(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    raw: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let name = primary_author_name(raw);
    if name.is_empty() {
        return Ok(None);
    }
    if let Some(id) = find_person_id_by_name(vault, &name)? {
        return Ok(Some(id));
    }
    create_minimal_person(app, state, vault, name).map(Some)
}

/// Write a bare person file (name + derived initials, everything else blank)
/// and index it. Used when capture links an author who isn't in the vault yet.
fn create_minimal_person(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    name: String,
) -> Result<String, String> {
    std::fs::create_dir_all(vault.join("people")).map_err(|e| e.to_string())?;
    let id = unique_id(vault, &slugify_name(&name))?;
    let path = person_path(vault, &id)?;
    let mut person = ParsedPerson {
        id: id.clone(),
        initials: initials_from_name(&name),
        name,
        role: String::new(),
        company: String::new(),
        email: String::new(),
        relationship: String::new(),
        area: None,
        avatar: None,
        created: Some(chrono::Local::now().to_rfc3339()),
        favorite: false,
        body: String::new(),
    };
    write_person(state, &path, &mut person)?;
    index_person(app, state, vault, &path, &person);
    refresh_email_index(state, vault);
    Ok(id)
}

#[tauri::command]
pub fn person_update(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    update: PersonUpdate,
) -> Result<PersonDto, String> {
    let vault = vault_root(&app)?;
    let path = person_path(&vault, &id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut person = parsers::parse_person(&content).map_err(|e| format!("{:#}", e))?;

    if let Some(n) = update.name {
        person.name = n;
    }
    if let Some(i) = update.initials {
        person.initials = i;
    }
    if let Some(r) = update.role {
        person.role = r;
    }
    if let Some(c) = update.company {
        person.company = c;
    }
    if let Some(e) = update.email {
        person.email = e;
    }
    if let Some(r) = update.relationship {
        person.relationship = r;
    }
    if let Some(s) = update.area {
        person.area = s;
    }
    if let Some(a) = update.avatar {
        person.avatar = a;
    }
    if let Some(f) = update.favorite {
        person.favorite = f;
    }
    if let Some(b) = update.body {
        person.body = b;
    }

    write_person(&state, &path, &mut person)?;
    index_person(&app, &state, &vault, &path, &person);
    refresh_email_index(&state, &vault);
    Ok(PersonDto::from_parsed(person, &vault, &path))
}

/// Persist a new avatar image for the person. `bytes` is the raw
/// image payload (the frontend reads `File.arrayBuffer()` and ships
/// the buffer); `ext` is the source extension without the leading dot
/// (e.g. "jpg"). The image is written to
/// `<vault>/attachments/people/<id>-<short-ulid>.<ext>` and the
/// person's frontmatter `avatar:` field is updated to the
/// vault-relative path of that file.
///
/// A short-ulid suffix in the filename serves two purposes:
///   1. **Cache-busting.** Webview image caches key off URL; replacing
///      the bytes at the same filename would leave the old image
///      visible until reload. A new filename per upload sidesteps
///      that without any cache-control machinery.
///   2. **Atomicity of replacement.** The new file lands first; if
///      anything fails before the frontmatter update, the previous
///      avatar still resolves.
///
/// Stale avatar files (the previous upload, if it lived under
/// `attachments/people/`) are moved to Woodshed's recoverable trash after
/// the new one is in place.
#[tauri::command]
pub fn person_avatar_set(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    bytes: Vec<u8>,
    ext: String,
) -> Result<PersonDto, String> {
    if bytes.is_empty() {
        return Err("avatar bytes were empty".into());
    }
    let vault = vault_root(&app)?;
    let person_md = person_path(&vault, &id)?;
    let content = vault_lib::read_record(&person_md).map_err(|e| e.to_string())?;
    let mut person = parsers::parse_person(&content).map_err(|e| format!("{:#}", e))?;

    let ext_clean = sanitize_avatar_ext(&ext)?;
    crate::commands::attachments::validate_image_upload(&bytes, &ext_clean)?;
    let attachments_dir = vault_lib::ensure_vault_directory(&vault, &["attachments", "people"])?;

    let filename = build_avatar_filename(&id, &ext_clean);
    let new_abs = vault_lib::confined_file_path(&vault, &attachments_dir, &filename)?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(&new_abs);
    }
    vault_lib::write_binary_atomic(&new_abs, &bytes).map_err(|e| e.to_string())?;

    // Frontmatter holds the vault-relative path so the markdown stays
    // portable (the image moves with the file).
    let new_rel = format!("attachments/people/{}", filename);
    let old_avatar = person.avatar.take();
    person.avatar = Some(new_rel);

    write_person(&state, &person_md, &mut person)?;
    index_person(&app, &state, &vault, &person_md, &person);

    // Sweep the previous file if it lived under attachments/. Unsupported
    // legacy or external paths leave nothing on disk to clean.
    if let Some(old) = old_avatar {
        trash_avatar_file_if_managed(&vault, &old);
    }

    Ok(PersonDto::from_parsed(person, &vault, &person_md))
}

/// Clear the person's avatar. Moves the on-disk file to recoverable trash
/// when it was a vault-managed attachment; unsupported paths just get the
/// frontmatter cleared (we don't own those bytes).
#[tauri::command]
pub fn person_avatar_clear(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<PersonDto, String> {
    let vault = vault_root(&app)?;
    let person_md = person_path(&vault, &id)?;
    let content = vault_lib::read_record(&person_md).map_err(|e| e.to_string())?;
    let mut person = parsers::parse_person(&content).map_err(|e| format!("{:#}", e))?;

    let old_avatar = person.avatar.take();
    write_person(&state, &person_md, &mut person)?;
    index_person(&app, &state, &vault, &person_md, &person);

    if let Some(old) = old_avatar {
        trash_avatar_file_if_managed(&vault, &old);
    }

    Ok(PersonDto::from_parsed(person, &vault, &person_md))
}

fn avatar_attachments_dir(vault: &Path) -> PathBuf {
    vault.join("attachments").join("people")
}

/// Normalize a user-supplied extension to the small whitelist we
/// support. Strips a leading dot, lowercases, rejects anything else.
fn sanitize_avatar_ext(raw: &str) -> Result<String, String> {
    let lower = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    match lower.as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "gif" => Ok(lower),
        _ => Err(format!(
            "unsupported avatar extension {raw:?} — expected jpg/png/webp/gif"
        )),
    }
}

fn build_avatar_filename(id: &str, ext: &str) -> String {
    // Last 6 chars of a fresh ULID. A ULID is 26 chars: first 10 are
    // timestamp (shared between two uploads in the same millisecond),
    // last 16 are random. Taking from the random tail keeps two
    // back-to-back uploads distinct — required so cache-busting works.
    let ulid = ulid::Ulid::new().to_string();
    let tail: String = ulid
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>()
        .to_ascii_lowercase();
    format!("{id}-{tail}.{ext}")
}

/// Best-effort trash of a previous avatar file, but only when the
/// stored path is a vault-relative attachment we own. Avoids touching
/// legacy bundled paths, URLs, or any absolute path the user might have
/// manually entered.
fn trash_avatar_file_if_managed(vault: &Path, raw: &str) {
    let trimmed = raw.trim();
    if !trimmed.starts_with("attachments/") {
        return;
    }
    let abs = vault.join(trimmed);
    // Sanity check: never escape the attachments dir (defends against a
    // hand-edited frontmatter with `..` segments).
    let attachments = avatar_attachments_dir(vault);
    let Ok(canonical_attachments) = attachments.canonicalize() else {
        return;
    };
    let parent = abs.parent().and_then(|p| p.canonicalize().ok());
    if parent.as_deref() != Some(canonical_attachments.as_path()) {
        return;
    }
    let _ = vault_lib::move_to_trash(vault, &abs);
}

#[tauri::command]
pub fn person_delete(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let path = person_path(&vault, &id)?;
    // Capture the labels its creation trace was logged under *before* the file
    // is gone, so we can scrub that backlink from the day's journal.
    let mut labels = vec![id.clone()];
    if let Ok(person) = read_person(&vault, &path) {
        crate::wikilinks::push_unique_label(
            &mut labels,
            &safe_wikilink_label(&person.name, &person.id),
        );
    }
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(&path);
    }
    if path.exists() {
        vault_lib::move_to_trash(&vault, &path)?;
    }
    unindex_person(&app, &state, &id);
    refresh_email_index(&state, &vault);
    if let Err(e) = crate::wikilinks::remove_record_backlinks(&app, &state, &vault, &labels) {
        eprintln!("scrub backlinks for person {}: {}", id, e);
    }
    Ok(())
}

#[tauri::command]
pub async fn people_all(app: AppHandle) -> Result<Vec<PersonDto>, String> {
    let vault = vault_root(&app)?;
    read_all_people(&vault)
}

/// Scan every `people/*.md` and produce a flat list of `PersonRef`s
/// ready for the people-email index. Cheap on the order of tens of
/// milliseconds for a few-hundred-person vault — the full scan
/// happens at watcher_start and after person create/update/delete,
/// never on the cadence read path. Skips files that fail to parse
/// (same tolerance as `read_all_people`).
pub fn build_email_index(vault: &Path) -> Vec<crate::state::PersonRef> {
    let mut out: Vec<crate::state::PersonRef> = Vec::new();
    let dir = vault.join("people");
    if !vault_lib::is_real_directory(&dir) {
        return out;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !vault_lib::is_real_file(&path)
        {
            continue;
        }
        let Ok(content) = vault_lib::read_record(&path) else {
            continue;
        };
        let Ok(person) = parsers::parse_person(&content) else {
            continue;
        };
        let email = person.email.trim().to_ascii_lowercase();
        let area = person
            .area
            .as_ref()
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty());
        out.push(crate::state::PersonRef {
            id: person.id,
            name: person.name,
            email: if email.is_empty() { None } else { Some(email) },
            area,
        });
    }
    out
}

/// Recompute the email index and swap it in. Called on watcher start
/// and after any mutation that could shift the `email → id` mapping
/// (create, update, delete). Cheap enough to do as a full rebuild
/// rather than reasoning about per-event diffs.
pub fn refresh_email_index(state: &State<AppState>, vault: &Path) {
    state.people_email_index.replace(build_email_index(vault));
}

pub(crate) fn read_all_people(vault: &Path) -> Result<Vec<PersonDto>, String> {
    let dir = vault.join("people");
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
        match read_person(vault, &path) {
            Ok(p) => out.push(p),
            Err(e) => eprintln!("skipping {}: {}", path.display(), e),
        }
    }
    out.sort_by_key(|person| person.name.to_lowercase());
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

    fn write_sample_person(vault: &Path, id: &str, name: &str) -> PathBuf {
        let person = ParsedPerson {
            id: id.to_string(),
            name: name.to_string(),
            initials: initials_from_name(name),
            role: "Engineer".to_string(),
            company: "Woodshed".to_string(),
            email: format!("{}@woodshed.com", id),
            relationship: String::new(),
            area: Some("woodshed".to_string()),
            avatar: None,
            created: None,
            favorite: false,
            body: String::new(),
        };
        let path = person_path(vault, id).unwrap();
        let serialized = parsers::serialize_person(&person).unwrap();
        std::fs::write(&path, serialized).unwrap();
        path
    }

    #[test]
    fn slugify_name_handles_typical_names() {
        assert_eq!(slugify_name("Alex Rivera"), "alex-rivera");
        assert_eq!(slugify_name("Sam O'Brien"), "sam-o-brien");
        assert_eq!(slugify_name("J.J. Abrams"), "j-j-abrams");
    }

    #[test]
    fn slugify_empty_falls_back() {
        assert_eq!(slugify_name(""), "person");
        assert_eq!(slugify_name("---"), "person");
    }

    #[test]
    fn unique_id_appends_2_3_on_collision() {
        let (_tmp, vault) = setup_vault();
        write_sample_person(&vault, "alex", "Alex");
        assert_eq!(unique_id(&vault, "alex").unwrap(), "alex-2");
        write_sample_person(&vault, "alex-2", "Alex Rivera");
        assert_eq!(unique_id(&vault, "alex").unwrap(), "alex-3");
    }

    #[test]
    fn initials_from_name_takes_first_two_words() {
        assert_eq!(initials_from_name("Alex Rivera"), "AR");
        assert_eq!(initials_from_name("Sam"), "S");
        assert_eq!(initials_from_name("Mary Jane Watson"), "MJ");
        assert_eq!(initials_from_name(""), "");
    }

    #[test]
    fn read_all_people_sorts_alphabetically() {
        let (_tmp, vault) = setup_vault();
        write_sample_person(&vault, "zach", "Zach");
        write_sample_person(&vault, "alice", "Alice");
        write_sample_person(&vault, "marco", "Marco");

        let people = read_all_people(&vault).unwrap();
        let names: Vec<_> = people.iter().map(|p| p.name.clone()).collect();
        assert_eq!(names, vec!["Alice", "Marco", "Zach"]);
    }

    #[test]
    fn read_all_people_skips_non_md_files() {
        let (_tmp, vault) = setup_vault();
        write_sample_person(&vault, "alex", "Alex");
        std::fs::write(vault.join("people").join("not-a-person.txt"), "noise").unwrap();
        assert_eq!(read_all_people(&vault).unwrap().len(), 1);
    }

    #[test]
    fn read_all_people_skips_corrupt_files() {
        let (_tmp, vault) = setup_vault();
        write_sample_person(&vault, "alex", "Alex");
        std::fs::write(
            vault.join("people").join("corrupt.md"),
            "this is not valid frontmatter",
        )
        .unwrap();
        assert_eq!(read_all_people(&vault).unwrap().len(), 1);
    }

    #[test]
    fn read_all_people_returns_empty_when_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        assert!(read_all_people(&vault).unwrap().is_empty());
    }

    #[test]
    fn sanitize_avatar_ext_accepts_image_types() {
        assert_eq!(sanitize_avatar_ext("jpg").unwrap(), "jpg");
        assert_eq!(sanitize_avatar_ext(".PNG").unwrap(), "png");
        assert_eq!(sanitize_avatar_ext("WebP").unwrap(), "webp");
    }

    #[test]
    fn sanitize_avatar_ext_rejects_other_extensions() {
        assert!(sanitize_avatar_ext("exe").is_err());
        assert!(sanitize_avatar_ext("").is_err());
        assert!(sanitize_avatar_ext("svg").is_err());
    }

    #[test]
    fn build_avatar_filename_embeds_id_and_ext() {
        let name = build_avatar_filename("alex-rivera", "jpg");
        assert!(name.starts_with("alex-rivera-"));
        assert!(name.ends_with(".jpg"));
        // id + dash + 6 ulid chars + ".jpg" = id.len() + 1 + 6 + 4
        assert_eq!(name.len(), "alex-rivera".len() + 1 + 6 + 4);
    }

    #[test]
    fn build_avatar_filename_is_unique_across_calls() {
        // Successive ULIDs differ — two uploads for the same person
        // never share a filename, which is how we cache-bust without
        // any cache-control machinery.
        let a = build_avatar_filename("alex", "jpg");
        let b = build_avatar_filename("alex", "jpg");
        assert_ne!(a, b);
    }

    #[test]
    fn resolve_avatar_rejects_legacy_bundled_and_external_paths() {
        let (_tmp, vault) = setup_vault();
        for raw in [
            "/avatars/alex.jpg",
            "https://example.com/avatar.jpg",
            "http://example.com/avatar.jpg",
            "data:image/png;base64,iVBORw0KGgo=",
            "/private/tmp/avatar.jpg",
            "attachments/other/avatar.jpg",
        ] {
            assert_eq!(resolve_avatar_for_dto(&vault, Some(raw.into())), None);
        }
    }

    #[test]
    fn resolve_avatar_expands_vault_relative_to_absolute() {
        let (_tmp, vault) = setup_vault();
        let attachments = avatar_attachments_dir(&vault);
        std::fs::create_dir_all(&attachments).unwrap();
        std::fs::write(attachments.join("alex-abc.jpg"), b"image").unwrap();
        let resolved =
            resolve_avatar_for_dto(&vault, Some("attachments/people/alex-abc.jpg".into()));
        let expected = vault
            .join("attachments/people/alex-abc.jpg")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(resolved, Some(expected));
    }

    #[test]
    fn resolve_avatar_rejects_missing_files_and_path_escapes() {
        let (_tmp, vault) = setup_vault();
        std::fs::create_dir_all(avatar_attachments_dir(&vault)).unwrap();
        assert_eq!(
            resolve_avatar_for_dto(&vault, Some("attachments/people/missing.jpg".into())),
            None
        );
        assert_eq!(
            resolve_avatar_for_dto(
                &vault,
                Some("attachments/people/../../people/alex-rivera.md".into())
            ),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_avatar_rejects_symlinked_files() {
        use std::os::unix::fs::symlink;

        let (_tmp, vault) = setup_vault();
        let attachments = avatar_attachments_dir(&vault);
        std::fs::create_dir_all(&attachments).unwrap();
        let real = vault.join("outside.jpg");
        std::fs::write(&real, b"image").unwrap();
        symlink(&real, attachments.join("linked.jpg")).unwrap();
        assert_eq!(
            resolve_avatar_for_dto(&vault, Some("attachments/people/linked.jpg".into())),
            None
        );
    }

    #[test]
    fn resolve_avatar_returns_none_for_missing_or_blank() {
        let (_tmp, vault) = setup_vault();
        assert_eq!(resolve_avatar_for_dto(&vault, None), None);
        assert_eq!(resolve_avatar_for_dto(&vault, Some("   ".into())), None);
    }

    #[test]
    fn trash_avatar_file_if_managed_moves_attachment_to_trash() {
        let (_tmp, vault) = setup_vault();
        let dir = avatar_attachments_dir(&vault);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("alex-abc.jpg");
        std::fs::write(&file, b"\x89PNG\r\n").unwrap();
        assert!(file.exists());
        trash_avatar_file_if_managed(&vault, "attachments/people/alex-abc.jpg");
        assert!(!file.exists());
        let trash = vault.join(".woodshed").join("trash");
        assert!(trash.is_dir());
    }

    #[test]
    fn trash_avatar_file_if_managed_leaves_external_paths() {
        let (_tmp, vault) = setup_vault();
        // Legacy bundled path — no on-disk file; the helper must not
        // panic or touch anything outside the vault.
        trash_avatar_file_if_managed(&vault, "/avatars/alex.jpg");
        trash_avatar_file_if_managed(&vault, "https://example.com/alex.jpg");
        // Sanity: a hand-crafted escape attempt is ignored because
        // the canonicalized parent dir won't match attachments/people.
        let dir = avatar_attachments_dir(&vault);
        std::fs::create_dir_all(&dir).unwrap();
        let outside = vault.join("outside.jpg");
        std::fs::write(&outside, b"x").unwrap();
        trash_avatar_file_if_managed(&vault, "attachments/people/../../outside.jpg");
        assert!(outside.exists(), "escape attempt should not delete file");
    }
}
