// Tag-table surface. Tags become tables: every `#tag` in the vault gets
// an auto-generated view that lists every record carrying that tag.
//
// This is the first implementation of the long-planned "tags are tables"
// feature. `#event` is the canonical use case — every event file gets
// the tag implicitly (via `type: event`), and the resulting table is
// where the user navigates from the cadence schedule block.
//
// Membership rules:
//   - `#event` is special-cased: every file with `type: event` qualifies,
//     plus every iCal-cached event. No explicit `event` tag persistence
//     required (the type does the work).
//   - Other tags: match if `tag` appears in the file's `tags:` frontmatter
//     OR if `#tag` appears as an inline hashtag in the body.
//
// Membership is maintained as normalized SQLite edges by the vault index.
// A query asks the index for matching relative paths, then parses only those
// records into rich per-type rows. iCal cache projections remain in memory.

use crate::commands::{
    events::{self, EventDto},
    tables,
};
use crate::parsers::{self, EventProvider};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagTableRow {
    /// Source record id. Stable across renames.
    pub id: String,
    /// Display title. For events that's the event title; for tasks the
    /// content; etc.
    pub title: String,
    /// Source record type:
    /// `event | task | note | person | resource | area | mail | row`.
    /// The frontend uses this to render the per-type icon and route to
    /// the right detail page.
    #[serde(rename = "type")]
    pub type_: String,
    /// Date associated with the row. Semantics depend on `type_`:
    ///   - event: the event's start datetime
    ///   - task:  the scheduled date (or empty if unscheduled)
    ///   - note:  the created timestamp
    ///   - person: empty (no obvious date)
    ///   - resource: the saved timestamp
    ///   - area: the created timestamp (often empty for legacy areas)
    ///
    /// Strings rather than typed dates so the frontend formats once.
    pub date: String,
    /// Area assignment (e.g. "acme"). Empty when absent.
    pub area: String,
    /// Vault-relative path to the source file (`events/<id>.md`, etc.)
    /// or a virtual path for iCal-cached rows (`gcal-cache/<id>.json`).
    pub path: String,
    /// The full DTO when this row is an iCal-projected event. The
    /// frontend prefers this when present so iCal rows in the `#event`
    /// table route to /cadence/event/ical/<account>/<external_id>
    /// rather than trying to load a vault file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<EventDto>,
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

/// Strip the vault root prefix and return a forward-slash relative path.
fn rel(vault: &Path, p: &Path) -> String {
    p.strip_prefix(vault)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn tag_table(
    app: AppHandle,
    state: State<'_, AppState>,
    tag: String,
) -> Result<Vec<TagTableRow>, String> {
    let vault = vault_root(&app)?;

    // `#event` matches every record of type:event (vault file or iCal
    // cache). Other tags require explicit frontmatter or inline use.
    let want = tag.trim_start_matches('#').to_string();
    let want_lc = want.to_lowercase();

    // Memo: serve the cached rows when the vault generation hasn't moved
    // since we last computed them for this tag. The generation is bumped
    // on every write (internal via record_self_write, external via the
    // watcher callback), so a stale entry is always detected here and
    // recomputed. Keyed on the normalized (lowercased, hash-stripped)
    // tag so `#Event`, `event`, and `#event` share one entry.
    let generation = state.vault_generation();
    if let Some((cached_gen, rows)) = state.tag_table_cache.lock_recover().get(&want_lc) {
        if *cached_gen == generation {
            return Ok(rows.clone());
        }
    }

    let rows = compute_tag_rows(&app, &vault, &want_lc, &state)?;

    state
        .tag_table_cache
        .lock()
        .unwrap()
        .insert(want_lc, (generation, rows.clone()));

    Ok(rows)
}

/// Parse the indexed matching files (plus the iCal cache for `#event`) and return
/// the sorted rows for `want_lc` (already normalized: lowercased, no
/// leading `#`). Pure with respect to the cache — the memo in `tag_table`
/// wraps this. Preserves the original command's error propagation: a scan
/// that errors fails the whole call (so the frontend never silently shows
/// a partial table).
fn compute_tag_rows(
    app: &AppHandle,
    vault: &Path,
    want_lc: &str,
    state: &State<AppState>,
) -> Result<Vec<TagTableRow>, String> {
    let is_event_tag = want_lc == "event";
    let mut rows = Vec::new();
    let indexed_paths = state
        .ensure_index(app)?
        .tagged_paths(want_lc)
        .map_err(|e| format!("query tag index: {e}"))?;

    scan_events(
        vault,
        want_lc,
        is_event_tag,
        Some(&indexed_paths),
        state,
        &mut rows,
    )?;
    scan_ical_note_tags(
        vault,
        want_lc,
        is_event_tag,
        Some(&indexed_paths),
        &mut rows,
    )?;
    scan_tasks(vault, want_lc, Some(&indexed_paths), &mut rows)?;
    scan_notes(vault, want_lc, Some(&indexed_paths), &mut rows)?;
    scan_people(vault, want_lc, Some(&indexed_paths), &mut rows)?;
    scan_resources(vault, want_lc, Some(&indexed_paths), &mut rows)?;
    scan_areas(vault, want_lc, Some(&indexed_paths), &mut rows)?;
    // Mail is intentionally NOT scanned. Email bodies are sender-authored
    // HTML/marketing copy, so harvesting inline `#hashtags` from them
    // surfaces noise — CSS hex colors (#fff, #ccc), tracking codes, and
    // campaign hashtags (#portfoliolife) — none of which are the user's
    // vault tags. There's no UI to apply a tag to a message, so mail has
    // nothing legitimate to contribute to the tag-tables surface.
    scan_table_rows_for_tag(vault, want_lc, Some(&indexed_paths), &mut rows)?;

    if is_event_tag {
        scan_ical_cache_events(app, vault, state, &mut rows);
    }

    // Newest-first: tasks/events sort by their date, notes by created.
    // Empty dates sort to the bottom.
    rows.sort_by(|a, b| match (a.date.is_empty(), b.date.is_empty()) {
        (true, true) => a.title.cmp(&b.title),
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => b.date.cmp(&a.date),
    });

    Ok(rows)
}

fn body_has_inline_tag(body: &str, want: &str) -> bool {
    crate::index::extract_inline_tags(body)
        .iter()
        .any(|tag| tag == want)
}

fn tags_match(tags: &[String], want: &str) -> bool {
    tags.iter().any(|t| t.to_lowercase() == want)
}

fn each_md_file(
    vault: &Path,
    dir: &Path,
    selected_paths: Option<&HashSet<String>>,
    mut f: impl FnMut(PathBuf, String),
) -> Result<(), String> {
    if !vault_lib::is_real_directory(dir) {
        return Ok(());
    }
    if let Some(selected) = selected_paths {
        for relative in selected {
            let path = vault.join(relative);
            if path.parent() != Some(dir)
                || path.extension().and_then(|s| s.to_str()) != Some("md")
                || !vault_lib::is_real_file(&path)
            {
                continue;
            }
            let Ok(content) = vault_lib::read_record(&path) else {
                continue;
            };
            f(path, content);
        }
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !vault_lib::is_real_file(&path)
        {
            continue;
        }
        let content = match vault_lib::read_record(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        f(path, content);
    }
    Ok(())
}

fn scan_events(
    vault: &Path,
    want: &str,
    is_event_tag: bool,
    selected_paths: Option<&HashSet<String>>,
    state: &State<AppState>,
    rows: &mut Vec<TagTableRow>,
) -> Result<(), String> {
    each_md_file(
        vault,
        &vault_lib::events_dir(vault),
        selected_paths,
        |path, content| {
            let event = match parsers::parse_event(&content) {
                Ok(e) => e,
                Err(_) => return,
            };
            // Skip iCal notes-attachment files — the cache projection is
            // the canonical "row" for iCal events; the file is just a
            // body store.
            if event.provider == Some(EventProvider::Ical) {
                return;
            }
            let matches = is_event_tag
                || tags_match(&event.tags, want)
                || body_has_inline_tag(&event.body, want);
            if !matches {
                return;
            }
            let mut dto = EventDto::from_parsed(event, vault, &path);
            events::enrich_resolved_attendees(&mut dto, state);
            rows.push(TagTableRow {
                id: dto.id.clone(),
                title: dto.title.clone(),
                type_: "event".into(),
                date: dto.date.clone(),
                area: dto.area.clone(),
                path: rel(vault, &path),
                event: Some(dto),
            });
        },
    )
}

fn scan_ical_note_tags(
    vault: &Path,
    want: &str,
    is_event_tag: bool,
    selected_paths: Option<&HashSet<String>>,
    rows: &mut Vec<TagTableRow>,
) -> Result<(), String> {
    if is_event_tag {
        return Ok(());
    }
    each_md_file(
        vault,
        &vault_lib::events_dir(vault),
        selected_paths,
        |path, content| {
            let event = match parsers::parse_event(&content) {
                Ok(e) => e,
                Err(_) => return,
            };
            if event.provider != Some(EventProvider::Ical) {
                return;
            }
            if !(tags_match(&event.tags, want) || body_has_inline_tag(&event.body, want)) {
                return;
            }
            let dto = EventDto::from_parsed(event, vault, &path);
            rows.push(TagTableRow {
                id: dto.id.clone(),
                title: dto.title.clone(),
                type_: "event".into(),
                date: dto.date.clone(),
                area: dto.area.clone(),
                path: rel(vault, &path),
                event: Some(dto),
            });
        },
    )
}

fn scan_tasks(
    vault: &Path,
    want: &str,
    selected_paths: Option<&HashSet<String>>,
    rows: &mut Vec<TagTableRow>,
) -> Result<(), String> {
    each_md_file(
        vault,
        &vault.join("tasks"),
        selected_paths,
        |path, content| {
            let task = match parsers::parse_task(&content) {
                Ok(t) => t,
                Err(_) => return,
            };
            if !(tags_match(&task.tags, want) || body_has_inline_tag(&task.body, want)) {
                return;
            }
            rows.push(TagTableRow {
                id: task.id,
                title: task.content,
                type_: "task".into(),
                date: task.scheduled.unwrap_or_default(),
                area: task.area,
                path: rel(vault, &path),
                event: None,
            });
        },
    )
}

fn scan_notes(
    vault: &Path,
    want: &str,
    selected_paths: Option<&HashSet<String>>,
    rows: &mut Vec<TagTableRow>,
) -> Result<(), String> {
    each_md_file(
        vault,
        &vault.join("notebook"),
        selected_paths,
        |path, content| {
            let note = match parsers::parse_note(&content) {
                Ok(n) => n,
                Err(_) => return,
            };
            if !(tags_match(&note.tags, want) || body_has_inline_tag(&note.body, want)) {
                return;
            }
            rows.push(TagTableRow {
                id: note.id,
                title: note.title,
                type_: "note".into(),
                date: note.created,
                area: note.area.unwrap_or_default(),
                path: rel(vault, &path),
                event: None,
            });
        },
    )
}

fn scan_people(
    vault: &Path,
    want: &str,
    selected_paths: Option<&HashSet<String>>,
    rows: &mut Vec<TagTableRow>,
) -> Result<(), String> {
    each_md_file(
        vault,
        &vault.join("people"),
        selected_paths,
        |path, content| {
            let person = match parsers::parse_person(&content) {
                Ok(p) => p,
                Err(_) => return,
            };
            // People don't carry a `tags:` field — match on body inline use only.
            if !body_has_inline_tag(&person.body, want) {
                return;
            }
            rows.push(TagTableRow {
                id: person.id,
                title: person.name,
                type_: "person".into(),
                date: String::new(),
                area: person.area.unwrap_or_default(),
                path: rel(vault, &path),
                event: None,
            });
        },
    )
}

fn scan_resources(
    vault: &Path,
    want: &str,
    selected_paths: Option<&HashSet<String>>,
    rows: &mut Vec<TagTableRow>,
) -> Result<(), String> {
    each_md_file(
        vault,
        &vault_lib::resources_dir(vault),
        selected_paths,
        |path, content| {
            let resource = match parsers::parse_resource(&content) {
                Ok(b) => b,
                Err(_) => return,
            };
            if !(tags_match(&resource.tags, want) || body_has_inline_tag(&resource.body, want)) {
                return;
            }
            rows.push(TagTableRow {
                id: resource.id,
                title: resource.title,
                type_: "resource".into(),
                date: resource.saved,
                area: String::new(),
                path: rel(vault, &path),
                event: None,
            });
        },
    )
}

fn scan_areas(
    vault: &Path,
    want: &str,
    selected_paths: Option<&HashSet<String>>,
    rows: &mut Vec<TagTableRow>,
) -> Result<(), String> {
    each_md_file(
        vault,
        &vault_lib::areas_dir(vault),
        selected_paths,
        |path, content| {
            let area = match parsers::parse_area(&content) {
                Ok(a) => a,
                Err(_) => return,
            };
            if !body_has_inline_tag(&area.body, want) {
                return;
            }
            rows.push(TagTableRow {
                id: area.id.clone(),
                title: area.name,
                type_: "area".into(),
                date: area.created.unwrap_or_default(),
                area: area.id,
                path: rel(vault, &path),
                event: None,
            });
        },
    )
}

fn scan_table_rows_for_tag(
    vault: &Path,
    want: &str,
    selected_paths: Option<&HashSet<String>>,
    rows: &mut Vec<TagTableRow>,
) -> Result<(), String> {
    each_table_row(vault, selected_paths, |path, row| {
        if !body_has_inline_tag(&table_row_body(&row), want) {
            return;
        }
        rows.push(TagTableRow {
            id: row.id.clone(),
            title: table_row_title(&row),
            type_: "row".into(),
            date: row.created.clone(),
            area: String::new(),
            path: rel(vault, &path),
            event: None,
        });
    })
}

fn each_table_row(
    vault: &Path,
    selected_paths: Option<&HashSet<String>>,
    mut f: impl FnMut(PathBuf, parsers::Row),
) -> Result<(), String> {
    let root = tables::tables_root(vault);
    if !vault_lib::is_real_directory(&root) {
        return Ok(());
    }
    if let Some(selected) = selected_paths {
        for relative in selected {
            let path = vault.join(relative);
            let Ok(remainder) = path.strip_prefix(&root) else {
                continue;
            };
            if remainder.components().count() != 2
                || path.file_name().and_then(|s| s.to_str()) == Some("_schema.md")
                || path.extension().and_then(|s| s.to_str()) != Some("md")
                || !path.parent().is_some_and(vault_lib::is_real_directory)
                || !vault_lib::is_real_file(&path)
            {
                continue;
            }
            let Ok(content) = vault_lib::read_record(&path) else {
                continue;
            };
            let Ok(row) = parsers::parse_row(&content) else {
                continue;
            };
            f(path, row);
        }
        return Ok(());
    }
    for table_entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let table_entry = table_entry.map_err(|e| e.to_string())?;
        let table_dir = table_entry.path();
        if !vault_lib::is_real_directory(&table_dir) {
            continue;
        }
        for row_entry in std::fs::read_dir(&table_dir).map_err(|e| e.to_string())? {
            let row_entry = row_entry.map_err(|e| e.to_string())?;
            let path = row_entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md")
                || path.file_name().and_then(|s| s.to_str()) == Some("_schema.md")
                || !vault_lib::is_real_file(&path)
            {
                continue;
            }
            if selected_paths.is_some_and(|selected| !selected.contains(&rel(vault, &path))) {
                continue;
            }
            let Ok(content) = vault_lib::read_record(&path) else {
                continue;
            };
            let Ok(row) = parsers::parse_row(&content) else {
                continue;
            };
            f(path, row);
        }
    }
    Ok(())
}

fn table_row_title(row: &parsers::Row) -> String {
    row.cells
        .values()
        .filter_map(yaml_value_text)
        .find(|value| !value.trim().is_empty())
        .unwrap_or_else(|| row.id.clone())
}

fn table_row_body(row: &parsers::Row) -> String {
    let cells = row
        .cells
        .values()
        .filter_map(yaml_value_text)
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    [cells, row.body.clone()]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn yaml_value_text(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::Null => None,
        serde_yaml::Value::Bool(value) => Some(value.to_string()),
        serde_yaml::Value::Number(value) => Some(value.to_string()),
        serde_yaml::Value::String(value) => Some(value.clone()),
        serde_yaml::Value::Sequence(values) => {
            let text = values
                .iter()
                .filter_map(yaml_value_text)
                .collect::<Vec<_>>()
                .join(", ");
            (!text.is_empty()).then_some(text)
        }
        serde_yaml::Value::Mapping(map) => {
            let text = map
                .iter()
                .filter_map(|(key, value)| {
                    Some(format!(
                        "{}: {}",
                        yaml_value_text(key)?,
                        yaml_value_text(value)?
                    ))
                })
                .collect::<Vec<_>>()
                .join(", ");
            (!text.is_empty()).then_some(text)
        }
        serde_yaml::Value::Tagged(tagged) => yaml_value_text(&tagged.value),
    }
}

/// Add a row for every iCal event currently in the cache. Used only by
/// the `#event` table — iCal events can't carry user-tagged frontmatter.
/// Each row carries the full DTO so the frontend can route to the
/// read-only iCal detail page without a second roundtrip.
fn scan_ical_cache_events(
    app: &AppHandle,
    _vault: &Path,
    state: &State<AppState>,
    rows: &mut Vec<TagTableRow>,
) {
    let dismissed = crate::commands::events::read_dismissed_uids(app).unwrap_or_default();
    // Cross-account dedupe by UID — same rationale as events_for_date:
    // a meeting that lives on two of the user's connected calendars
    // would otherwise show up twice. The unprojected path uses the
    // master VEVENT's dtstart, which is the same across calendars,
    // so deduping on UID alone is sufficient here.
    let mut seen_uids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (account_id, ev) in state.ical_cache.all_unprojected() {
        // Master-level filter: legacy whole-UID dismissals hide the
        // row from the tag table entirely. Per-occurrence dismissals
        // don't reach here — the tag table is one row per master.
        if crate::commands::events::is_dismissed(
            &dismissed,
            Some(&account_id),
            Some(&ev.uid),
            Some(ev.dtstart_rfc3339.as_str()),
        ) {
            continue;
        }
        if !seen_uids.insert(ev.uid.clone()) {
            continue;
        }
        let synthetic_id = crate::gcal::cache::synthetic_event_id(&account_id, &ev.uid);
        let description = crate::gcal::clean::clean_description(&ev.description);
        let meeting_url =
            crate::gcal::clean::extract_meeting_url(&ev.description, ev.location.as_deref());
        let mut dto = EventDto {
            id: synthetic_id.clone(),
            path: format!("gcal-cache/{}.json", account_id),
            title: if ev.summary.is_empty() {
                "(no title)".into()
            } else {
                ev.summary.clone()
            },
            subtitle: ev.location.clone(),
            date: ev.dtstart_rfc3339.clone(),
            duration: ev.duration_minutes,
            area: String::new(),
            attendees: ev.attendees.iter().map(|a| a.email.clone()).collect(),
            // Tag-table rows don't drive the per-attendee
            // wikilink rendering — the table view shows one row per
            // event, not per attendee. Left empty here; if a future
            // detail-page link surfaces the resolved attendees, the
            // caller can enrich.
            resolved_attendees: Vec::new(),
            recurring: ev.recurring_enum,
            provider: Some(EventProvider::Ical),
            account_id: Some(account_id.clone()),
            external_id: Some(ev.uid.clone()),
            writable: Some(false),
            rrule_original: ev.rrule_original.clone(),
            tags: Vec::new(),
            description: if description.is_empty() {
                None
            } else {
                Some(description)
            },
            meeting_url,
            local_overrides: None,
            body: String::new(),
        };
        // iCal events carry no upstream area; infer one from attendees so
        // the #event table's Area column matches the detail page rather
        // than showing a blank. Same read-time inference, no write-back.
        if let Some(area) = crate::commands::events::infer_area_from_attendees(
            &dto.attendees,
            true,
            &state.people_email_index,
        ) {
            dto.area = area;
        }
        rows.push(TagTableRow {
            id: dto.id.clone(),
            title: dto.title.clone(),
            type_: "event".into(),
            date: dto.date.clone(),
            area: dto.area.clone(),
            path: dto.path.clone(),
            event: Some(dto),
        });
    }
}

/// Return a list of every distinct tag the vault knows about, sorted.
/// Walk a body looking for inline `#hashtag` occurrences and emit each
/// match's tag name (lowercased, no leading `#`). Mirrors the boundary
/// rules of `body_has_inline_tag`: a tag starts after whitespace or one
/// of `( [ { ,`, its first character must be a letter, and it ends at
/// the first non-`[A-Za-z0-9_-]` char.
#[cfg(test)]
fn extract_inline_tags(body: &str) -> Vec<String> {
    crate::index::extract_inline_tags(body)
}

#[cfg(test)]
fn is_css_hex_literal(tag: &str) -> bool {
    crate::index::is_css_hex_literal(tag)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
    pub created: Option<String>,
}

/// Single-pass scan that emits tag, count, and earliest creation date
/// for every distinct tag the vault knows about. Powers the Tables sidebar's
/// auto-generated section without forcing N round-trips of `tag_table`, which
/// scans the vault once per call. `#event` is always present.
#[tauri::command]
pub async fn tags_with_counts(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TagCount>, String> {
    // Memo: keyed on the vault generation only (no per-tag argument). An
    // unchanged generation since the last full sweep serves the cached
    // counts without re-reading the vault.
    let generation = state.vault_generation();
    if let Some((cached_gen, counts)) = state.tags_counts_cache.lock_recover().as_ref() {
        if *cached_gen == generation {
            return Ok(counts.clone());
        }
    }

    let mut counts: std::collections::HashMap<String, (usize, Option<i64>)> = state
        .ensure_index(&app)?
        .tag_counts()
        .map_err(|e| format!("query tag counts: {e}"))?
        .into_iter()
        .map(|(tag, count, created_at)| (tag, (count, created_at)))
        .collect();

    let bump = |t: &str,
                created_at: Option<i64>,
                c: &mut std::collections::HashMap<String, (usize, Option<i64>)>| {
        if !t.is_empty() {
            let aggregate = c.entry(t.to_lowercase()).or_insert((0, None));
            aggregate.0 += 1;
            if let Some(candidate) = created_at {
                aggregate.1 = Some(
                    aggregate
                        .1
                        .map_or(candidate, |current| current.min(candidate)),
                );
            }
        }
    };

    // iCal events: count toward `#event` only, deduped by UID across
    // accounts (same rationale as in events_for_date) and excluding
    // anything the user has dismissed locally.
    let dismissed = crate::commands::events::read_dismissed_uids(&app).unwrap_or_default();
    let mut seen_uids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (account_id, ev) in state.ical_cache.all_unprojected() {
        if crate::commands::events::is_dismissed(
            &dismissed,
            Some(&account_id),
            Some(&ev.uid),
            Some(ev.dtstart_rfc3339.as_str()),
        ) {
            continue;
        }
        if seen_uids.insert(ev.uid.clone()) {
            // Calendar DTSTART is the event schedule, not the moment the
            // generated #event table was created.
            bump("event", None, &mut counts);
        }
    }

    // Always surface `#event` even on an empty vault so the sidebar's
    // canonical entry never disappears.
    counts.entry("event".to_string()).or_insert((0, None));

    let mut out: Vec<TagCount> = counts
        .into_iter()
        .map(|(tag, (count, created_at))| TagCount {
            tag,
            count,
            created: created_at.and_then(|millis| {
                chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
                    .map(|date| date.to_rfc3339())
            }),
        })
        .collect();
    // Sort by descending count, then alphabetically — most-used tags
    // float to the top of the sidebar, ties resolve deterministically.
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));

    *state.tags_counts_cache.lock_recover() = Some((generation, out.clone()));

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::atomic::Ordering;
    use tempfile::TempDir;

    fn temp_vault() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("vault");
        crate::vault::ensure_dirs(&vault).unwrap();
        (tmp, vault)
    }

    /// Construct a bare AppState for cache-logic tests. No watcher, no
    /// Tauri runtime — just the in-memory fields the memo touches.
    fn bare_state() -> crate::AppState {
        use std::sync::atomic::AtomicU64;
        use std::sync::{Arc, Mutex};
        crate::AppState {
            watcher: Mutex::new(None),
            events_index: Arc::new(crate::state::EventIndex::new()),
            events_cache: Arc::new(crate::state::EventsCache::new()),
            index: Mutex::new(None),
            gmail_pool: Arc::new(crate::gmail::GmailImapPool::new()),
            mail_mutations: Mutex::new(()),
            mail_mutation_epoch: AtomicU64::new(0),
            mail_message_epochs: Mutex::new(std::collections::HashMap::new()),
            gmail_creds: Arc::new(crate::gmail::CredsCache::new()),
            ical_cache: Arc::new(crate::gcal::IcalEventCache::new()),
            people_email_index: Arc::new(crate::state::PeopleEmailIndex::new()),
            vault_generation: Arc::new(AtomicU64::new(0)),
            tag_table_cache: Mutex::new(std::collections::HashMap::new()),
            tags_counts_cache: Mutex::new(None),
        }
    }

    /// Scan a task-bearing vault directly (no Tauri State) so cache tests
    /// can compare "freshly-scanned rows" against "cached rows". Mirrors
    /// the subset of compute_tag_rows that doesn't need AppState/AppHandle.
    fn scan_tasks_for(vault: &Path, want_lc: &str) -> Vec<TagTableRow> {
        let mut rows = Vec::new();
        scan_tasks(vault, want_lc, None, &mut rows).unwrap();
        rows
    }

    fn write_task(vault: &Path, id: &str, content: &str, tag: &str) {
        let task = parsers::Task {
            id: id.to_string(),
            content: content.to_string(),
            status: parsers::TaskStatus::Backlog,
            area: String::new(),
            created: Some("2026-06-08T12:00:00-04:00".to_string()),
            scheduled: None,
            tags: vec![tag.to_string()],
            time_spent_seconds: None,
            in_progress_started_at: None,
            sort_key: None,
            body: String::new(),
        };
        std::fs::write(
            vault.join("tasks").join(format!("{id}.md")),
            parsers::serialize_task(&task).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn vault_generation_bumps_and_reads() {
        let state = bare_state();
        assert_eq!(state.vault_generation(), 0);
        assert_eq!(state.vault_generation.fetch_add(1, Ordering::Relaxed), 0);
        assert_eq!(state.vault_generation(), 1);
        state.vault_generation.fetch_add(1, Ordering::Relaxed);
        assert_eq!(state.vault_generation(), 2);
    }

    #[test]
    fn tag_table_memo_serves_cache_without_rescan() {
        // This exercises the exact hit/miss logic tag_table uses against
        // the AppState.tag_table_cache map, without needing a live Tauri
        // State. We prove a same-generation lookup serves the stored rows
        // even after the vault changes (no rescan), and a post-bump lookup
        // recomputes fresh.
        let (_tmp, vault) = temp_vault();
        let state = bare_state();
        let want = "project";

        // Initial vault: one matching task.
        write_task(&vault, "t_001", "First task", want);

        // First call: miss → compute → store at gen 0.
        let gen0 = state.vault_generation();
        let computed = scan_tasks_for(&vault, want);
        assert_eq!(computed.len(), 1);
        state
            .tag_table_cache
            .lock()
            .unwrap()
            .insert(want.to_string(), (gen0, computed.clone()));

        // Mutate the vault WITHOUT bumping the generation: add a second
        // matching task on disk.
        write_task(&vault, "t_002", "Second task", want);

        // Same-generation lookup must serve the cached (stale) rows — proof
        // the cache was hit and no rescan happened. If it rescanned, we'd
        // see 2 rows.
        let cache = state.tag_table_cache.lock().unwrap();
        let (cached_gen, cached_rows) = cache.get(want).unwrap();
        assert_eq!(*cached_gen, state.vault_generation());
        assert_eq!(
            cached_rows.len(),
            1,
            "same-generation lookup must serve the pre-mutation cache, not rescan"
        );
        drop(cache);

        // Now a write bumps the generation; the cached entry's gen no
        // longer matches, so the command would recompute. Simulate that
        // recompute and confirm it reflects the new file.
        state.vault_generation.fetch_add(1, Ordering::Relaxed);
        let gen1 = state.vault_generation();
        assert_ne!(gen0, gen1);
        let recomputed = scan_tasks_for(&vault, want);
        assert_eq!(
            recomputed.len(),
            2,
            "post-bump recompute must reflect the second task"
        );
        state
            .tag_table_cache
            .lock()
            .unwrap()
            .insert(want.to_string(), (gen1, recomputed));

        // And the freshly-stored entry now matches the current generation.
        let cache = state.tag_table_cache.lock().unwrap();
        let (cached_gen, cached_rows) = cache.get(want).unwrap();
        assert_eq!(*cached_gen, state.vault_generation());
        assert_eq!(cached_rows.len(), 2);
    }

    #[test]
    fn tags_counts_memo_keyed_on_generation() {
        let state = bare_state();
        let gen0 = state.vault_generation();
        let counts = vec![TagCount {
            tag: "event".to_string(),
            count: 3,
            created: Some("2026-01-02T08:00:00+00:00".to_string()),
        }];
        *state.tags_counts_cache.lock().unwrap() = Some((gen0, counts.clone()));

        // Unchanged generation: cache is valid.
        {
            let guard = state.tags_counts_cache.lock().unwrap();
            let (cached_gen, cached) = guard.as_ref().unwrap();
            assert_eq!(*cached_gen, state.vault_generation());
            assert_eq!(cached.len(), 1);
        }

        // After a bump the cached generation no longer matches, so a read
        // detects the miss and would recompute.
        state.vault_generation.fetch_add(1, Ordering::Relaxed);
        {
            let guard = state.tags_counts_cache.lock().unwrap();
            let (cached_gen, _) = guard.as_ref().unwrap();
            assert_ne!(*cached_gen, state.vault_generation());
        }
    }

    #[test]
    fn index_rebuild_invalidates_both_tag_caches() {
        let state = bare_state();
        let generation = state.vault_generation();
        state
            .tag_table_cache
            .lock()
            .unwrap()
            .insert("roadmap".to_string(), (generation, Vec::new()));
        *state.tags_counts_cache.lock().unwrap() = Some((generation, Vec::new()));

        state.invalidate_tag_caches();

        assert!(state.tag_table_cache.lock().unwrap().is_empty());
        assert!(state.tags_counts_cache.lock().unwrap().is_none());
        assert_eq!(state.vault_generation(), generation + 1);
    }

    #[test]
    fn body_inline_match_respects_word_boundaries() {
        assert!(body_has_inline_tag("here is #event today", "event"));
        // #events != #event (suffix would create a false positive)
        assert!(!body_has_inline_tag("we had #events today", "event"));
        // Leading-comma works
        assert!(body_has_inline_tag(", #event,", "event"));
        // Inside a wikilink is fine
        assert!(body_has_inline_tag("see [[notes]] #event", "event"));
        // Case-insensitive
        assert!(body_has_inline_tag("HELLO #Event", "event"));
        // Bare word (no hash) does not count
        assert!(!body_has_inline_tag(
            "we should call this an event",
            "event"
        ));
        // Empty want never matches
        assert!(!body_has_inline_tag("anything", ""));
        // CSS colors and numeric fragments are not user tags.
        assert!(!body_has_inline_tag("color: #040d14;", "040d14"));
        assert!(!body_has_inline_tag("color: #ffffff;", "ffffff"));
        assert!(!body_has_inline_tag("html id #a0168128861", "a0168128861"));
        assert!(body_has_inline_tag("segment #b2b", "b2b"));
        assert!(!body_has_inline_tag("see issue #68", "68"));
    }

    #[test]
    fn extract_inline_tags_skips_color_literals() {
        assert_eq!(
            extract_inline_tags(
                "Use #idea and #b2b, not colors #040d14 or #ffffff, id #a0168128861, or issue #68."
            ),
            vec!["idea".to_string(), "b2b".to_string()]
        );
    }

    #[test]
    fn tags_match_is_case_insensitive() {
        let tags = vec!["Event".to_string(), "Sponsor".to_string()];
        assert!(tags_match(&tags, "event"));
        assert!(tags_match(&tags, "sponsor"));
        assert!(!tags_match(&tags, "task"));
    }

    #[test]
    fn extract_inline_tags_filters_css_hex_colors() {
        // CSS hex colors must never become tags — 3-digit shorthand
        // (#fff, #ccc) and 6/8-digit forms (#ffffff, #deadbeef) alike.
        // This is the noise that motivated dropping mail bodies from the
        // tag harvest, but the filter also guards pasted CSS in notes.
        let body = "Theme: #fff on #ccc, accent #ffffff and #deadbeef.\n\
                    Real tags survive: #design #cafe #portfolio.";
        let tags = extract_inline_tags(body);
        for junk in ["fff", "ccc", "ffffff", "deadbeef"] {
            assert!(!tags.contains(&junk.to_string()), "should drop #{junk}");
        }
        for real in ["design", "cafe", "portfolio"] {
            assert!(tags.contains(&real.to_string()), "should keep #{real}");
        }
    }

    #[test]
    fn is_css_hex_literal_catches_shorthand_not_words() {
        assert!(is_css_hex_literal("fff"));
        assert!(is_css_hex_literal("ccc"));
        assert!(is_css_hex_literal("ffffff"));
        assert!(is_css_hex_literal("deadbeef"));
        // 4- and 5-letter all-hex words are real tags, not colors.
        assert!(!is_css_hex_literal("cafe"));
        assert!(!is_css_hex_literal("decaf"));
        assert!(!is_css_hex_literal("design"));
    }

    #[test]
    fn scan_table_rows_matches_cell_and_body_tags() {
        let (_tmp, vault) = temp_vault();
        let table_dir = vault.join("tables").join("prospects");
        std::fs::create_dir_all(&table_dir).unwrap();
        std::fs::write(table_dir.join("_schema.md"), "---\ntype: table\n---\n").unwrap();

        let mut cells = BTreeMap::new();
        cells.insert(
            "col_name".to_string(),
            serde_yaml::Value::String("Acme #sponsor".to_string()),
        );
        let row = parsers::Row {
            id: "row_1".to_string(),
            table: "prospects".to_string(),
            created: "2026-06-08T12:00:00".to_string(),
            cells,
            body: "Next step #outreach".to_string(),
        };
        std::fs::write(
            table_dir.join("row_1.md"),
            parsers::serialize_row(&row).unwrap(),
        )
        .unwrap();

        let mut sponsor_rows = Vec::new();
        scan_table_rows_for_tag(&vault, "sponsor", None, &mut sponsor_rows).unwrap();
        assert_eq!(sponsor_rows.len(), 1);
        assert_eq!(sponsor_rows[0].type_, "row");
        assert_eq!(sponsor_rows[0].title, "Acme #sponsor");
        assert_eq!(sponsor_rows[0].path, "tables/prospects/row_1.md");

        let mut outreach_rows = Vec::new();
        scan_table_rows_for_tag(&vault, "outreach", None, &mut outreach_rows).unwrap();
        assert_eq!(outreach_rows.len(), 1);
        assert_eq!(outreach_rows[0].id, "row_1");
    }

    #[test]
    fn scan_ical_notes_matches_body_tags_without_event_duplication() {
        let (_tmp, vault) = temp_vault();
        let event = parsers::Event {
            id: "e_gcal_note".to_string(),
            title: "Design review".to_string(),
            subtitle: None,
            date: "2026-06-08T17:00:00+00:00".to_string(),
            duration: 30,
            area: "woodshed".to_string(),
            attendees: vec!["ada@example.com".to_string()],
            recurring: parsers::RecurringRule::None,
            provider: Some(EventProvider::Ical),
            account_id: Some("gcal_A".to_string()),
            external_id: Some("event-uid".to_string()),
            writable: Some(false),
            rrule_original: None,
            local_metadata_overrides: Vec::new(),
            tags: Vec::new(),
            body: "Capture the product call as a #decision.".to_string(),
        };
        std::fs::write(
            vault.join("events").join("e_gcal_note.md"),
            parsers::serialize_event(&event).unwrap(),
        )
        .unwrap();

        let mut decision_rows = Vec::new();
        scan_ical_note_tags(&vault, "decision", false, None, &mut decision_rows).unwrap();
        assert_eq!(decision_rows.len(), 1);
        assert_eq!(decision_rows[0].type_, "event");
        assert_eq!(
            decision_rows[0].event.as_ref().unwrap().provider,
            Some(EventProvider::Ical)
        );

        let mut event_rows = Vec::new();
        scan_ical_note_tags(&vault, "event", true, None, &mut event_rows).unwrap();
        assert!(event_rows.is_empty());
    }
}
