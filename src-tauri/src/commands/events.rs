// Calendar event commands. Vault-local events live one per file at
// `events/<id>.md` (vault layout shifted in May 2026 — events used to
// live inline as a frontmatter array on the daily file). Each event
// file's body is the user's meeting notes; the title/date/attendees/etc.
// live in the frontmatter. IDs are `e_<title-slug>_<short-ulid>` so the
// filename itself is human-skimmable in Finder / git diffs while the
// trailing 8-char ULID suffix preserves lexicographic creation order
// and guarantees uniqueness. The id → events-file path map in
// `EventIndex` is now mostly trivial (path is always `events/<id>.md`).
//
// Recurrence is still the small `none | daily | weekly | monthly` enum,
// expanded in-process by `events_for_date`. Recurring events are stored
// once; later occurrences are projected at read time.
//
// Read fallback: un-migrated vaults still have events inline in
// `cadence/<date>.md` frontmatter. `events_for_date` and `rebuild_index`
// both fall back to scanning the cadence dir when `events/` is empty.

use crate::parsers::{self, Event as ParsedEvent, EventProvider, RecurringRule};
use crate::state::{EventIndex, EventsCache};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttendeeDto {
    /// What the event file actually stores for this attendee:
    ///
    /// - Vault-local events: a person id (slug), e.g. `alex-rivera`.
    /// - iCal events: an email address, e.g. `alex@acme.com`.
    ///
    /// Frontend never displays this directly — it's the disambiguator
    /// the optimistic-mutation path uses when removing an attendee.
    pub raw: String,
    /// When `Some`, the attendee matched a person in the vault. The
    /// frontend renders these as clickable Wikilinks to
    /// `/people/<id>`. Unmatched entries render `email` (or `raw`)
    /// as plain text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub person_id: Option<String>,
    /// Display name for the row. For matched attendees this is the
    /// person's `name`; for unmatched iCal entries we fall back to
    /// the email; for unmatched vault-local ids (person was deleted)
    /// we surface the raw id so the user can clean it up.
    pub name: String,
    /// The email address, when known. iCal attendees always have one;
    /// vault-local attendees expose it only when the linked person
    /// has an email set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDto {
    pub id: String,
    /// Vault-relative path to the event file (e.g. `events/e_01HM3Z.md`).
    /// iCal-cached events use a virtual path under `gcal-cache/`. The
    /// path is per-event now that events are one-file-each; in the old
    /// inline layout multiple events for one day shared a daily path.
    pub path: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    /// ISO datetime. For recurring instances this is projected onto the
    /// queried day; the source event's `date` field stays at the original.
    pub date: String,
    pub duration: u32,
    pub area: String,
    pub attendees: Vec<String>,
    /// Per-attendee resolution against the People folder, computed
    /// server-side at DTO build time. Same length and ordering as
    /// `attendees`; each entry carries the raw value, the optional
    /// matched person, and the email when known. The frontend reads
    /// this to render person matches as clickable wikilinks. See
    /// `resolve_attendees` for the resolution rules.
    #[serde(default)]
    pub resolved_attendees: Vec<AttendeeDto>,
    pub recurring: RecurringRule,
    /// Provider-distinction passthrough. All five fields are `None` for
    /// vault-local events (the frontend reads `provider === undefined`
    /// as "user can edit, no source badge"). iCal-synced events carry
    /// the values populated by the gcal cache layer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<EventProvider>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub writable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rrule_original: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Cleaned meeting description for iCal events (HTML stripped,
    /// Google-redirect URLs unwrapped, blank-line runs collapsed). Set
    /// only on iCal events; vault-local events store everything they
    /// have to say about themselves in `body`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// First Zoom / Meet / Teams / Webex URL detected in the iCal
    /// description or LOCATION. Surfaced as a prominent "Join meeting"
    /// button on the event detail page so the user doesn't have to
    /// scan a wall of Google-redirect text for the link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_url: Option<String>,
    /// True when this iCal-projected event has a local override file
    /// at `events/<occurrence_id>.md` whose title/date/duration differ
    /// from the gcal cache. The frontend surfaces a "Modified locally"
    /// badge so the divergence from the upstream calendar is visible.
    /// Always None on vault-local events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_overrides: Option<bool>,
    pub body: String,
}

impl EventDto {
    pub(crate) fn from_parsed(event: ParsedEvent, vault: &Path, abs_path: &Path) -> Self {
        let rel = abs_path
            .strip_prefix(vault)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| abs_path.to_string_lossy().to_string());
        EventDto {
            id: event.id,
            path: rel,
            title: event.title,
            subtitle: event.subtitle,
            date: event.date,
            duration: event.duration,
            area: event.area,
            attendees: event.attendees,
            // Resolution against the people-email index happens
            // server-side in `enrich_resolved_attendees` — called by
            // the top-level read commands once they have AppState.
            // Leaving this empty here keeps from_parsed pure.
            resolved_attendees: Vec::new(),
            recurring: event.recurring,
            provider: event.provider,
            account_id: event.account_id,
            external_id: event.external_id,
            writable: event.writable,
            rrule_original: event.rrule_original,
            tags: event.tags,
            // Vault-local events don't have a separate description —
            // the body IS the user's writing. iCal projections set
            // these fields explicitly via the cache layer.
            description: None,
            meeting_url: None,
            local_overrides: None,
            body: event.body,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventUpdate {
    pub title: Option<String>,
    pub subtitle: Option<Option<String>>,
    pub date: Option<String>,
    pub duration: Option<u32>,
    pub area: Option<String>,
    pub attendees: Option<Vec<String>>,
    pub recurring: Option<RecurringRule>,
    pub body: Option<String>,
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

/// Absolute path to a vault-local event file: `events/<id>.md`.
pub(crate) fn event_path(vault: &Path, id: &str) -> Result<PathBuf, String> {
    vault_lib::record_file_path(vault, vault_lib::EVENTS_DIR, id)
}

/// Absolute path to an iCal event occurrence's local markdown file.
/// The id is the same one we mint for the iCal-projected DTO, so the
/// file path is predictable from any iCal EventDto without needing a
/// side table.
pub(crate) fn ical_notes_path(vault: &Path, synthetic_id: &str) -> Result<PathBuf, String> {
    event_path(vault, synthetic_id)
}

/// Snapshot of every account's dismissals, split between legacy
/// whole-UID dismissals (which hide every occurrence of the UID) and
/// per-occurrence dismissals (which hide only one `(uid, date)` row).
///
/// New dismissals use the per-occurrence form so clicking Hide on one
/// row never affects sibling rows. The legacy `dismissed_uids` field
/// stays read-write for back-compat — entries written before the
/// per-occurrence rollout still hide their whole UID until the user
/// restores them.
#[derive(Debug, Default)]
pub(crate) struct DismissedSet {
    /// Account → set of fully-dismissed UIDs (every occurrence
    /// hidden). Populated from `GcalAccountMeta.dismissed_uids`.
    uids: std::collections::HashMap<String, std::collections::HashSet<String>>,
    /// Account → set of `(uid, YYYY-MM-DD)` pairs. Populated from
    /// `GcalAccountMeta.dismissed_occurrences`.
    occurrences: std::collections::HashMap<String, std::collections::HashSet<(String, String)>>,
}

/// Read once per query (cheap — it's a small JSON read from the Tauri
/// store) and consulted while merging the iCal cache. Bubbling errors
/// from this read up to `events_for_date` would mean a corrupt store
/// blanks the whole calendar; instead, we treat read failure as
/// "nothing dismissed" so the user keeps seeing their events.
pub(crate) fn read_dismissed_uids(app: &AppHandle) -> Result<DismissedSet, String> {
    use std::collections::{HashMap, HashSet};
    let accounts = match crate::gcal::sync::read_all_accounts(app) {
        Ok(a) => a,
        Err(_) => return Ok(DismissedSet::default()),
    };
    let mut uids: HashMap<String, HashSet<String>> = HashMap::new();
    let mut occurrences: HashMap<String, HashSet<(String, String)>> = HashMap::new();
    for (id, meta) in accounts {
        if !meta.dismissed_uids.is_empty() {
            uids.insert(id.clone(), meta.dismissed_uids.into_iter().collect());
        }
        if !meta.dismissed_occurrences.is_empty() {
            let set: HashSet<(String, String)> = meta
                .dismissed_occurrences
                .into_iter()
                .map(|d| (d.uid, d.date))
                .collect();
            occurrences.insert(id, set);
        }
    }
    Ok(DismissedSet { uids, occurrences })
}

/// Is `(account_id, external_id, occurrence_date)` dismissed?
/// `occurrence_date` is the projected occurrence's date — pass
/// `Some("YYYY-MM-DD")` or `Some(<rfc3339>)`; the function reads the
/// first 10 chars. Use `None` only when the caller has no date (the
/// detail-page open path, which queries by UID alone).
pub(crate) fn is_dismissed(
    dismissed: &DismissedSet,
    account_id: Option<&str>,
    external_id: Option<&str>,
    occurrence_date: Option<&str>,
) -> bool {
    let (Some(a), Some(uid)) = (account_id, external_id) else {
        return false;
    };
    // Legacy whole-UID dismissal — hides every occurrence.
    if dismissed.uids.get(a).is_some_and(|set| set.contains(uid)) {
        return true;
    }
    // Per-occurrence dismissal.
    let Some(date) = occurrence_date.map(date_part) else {
        return false;
    };
    dismissed
        .occurrences
        .get(a)
        .is_some_and(|set| set.contains(&(uid.to_string(), date)))
}

/// First 10 chars of a date string. Tolerates RFC3339 (`2026-05-05T…`)
/// and plain `YYYY-MM-DD`. Anything shorter returns as-is.
fn date_part(s: &str) -> String {
    if s.len() >= 10 {
        s[..10].to_string()
    } else {
        s.to_string()
    }
}

fn ical_visible_row_key(dto: &EventDto) -> Option<(String, i64)> {
    Some((
        dto.title.trim().to_lowercase(),
        parse_event_date(&dto.date)?.timestamp(),
    ))
}

fn is_ical_dismissed_by_uid_date(
    dismissed: &DismissedSet,
    dto: &EventDto,
    overlay: Option<&ParsedEvent>,
) -> bool {
    let (Some(a), Some(uid)) = (dto.account_id.as_deref(), dto.external_id.as_deref()) else {
        return false;
    };
    let date = date_part(&dto.date);
    if dismissed
        .occurrences
        .get(a)
        .is_some_and(|set| set.contains(&(uid.to_string(), date)))
    {
        return !dismissal_is_stale_for_projection(dto, overlay);
    }
    // Legacy whole-UID dismissals predate per-occurrence hide. Keep
    // honoring them for one-off events, but don't let an old recurring
    // series hide suppress every future occurrence of an active series.
    dto.recurring == RecurringRule::None
        && dismissed.uids.get(a).is_some_and(|set| set.contains(uid))
}

fn dismissal_is_stale_for_projection(dto: &EventDto, overlay: Option<&ParsedEvent>) -> bool {
    let Some(overlay) = overlay else {
        return false;
    };
    if overlay_overrides(overlay, "date") {
        return false;
    }
    let Some(overlay_ts) = parse_event_date(&overlay.date).map(|d| d.timestamp()) else {
        return false;
    };
    let Some(dto_ts) = parse_event_date(&dto.date).map(|d| d.timestamp()) else {
        return false;
    };
    overlay_ts != dto_ts
}

fn hidden_ical_visible_row_keys<'a, F>(
    dismissed: &DismissedSet,
    candidates: impl IntoIterator<Item = &'a EventDto>,
    mut overlay_for: F,
) -> std::collections::HashSet<(String, i64)>
where
    F: FnMut(&EventDto) -> Option<ParsedEvent>,
{
    candidates
        .into_iter()
        .filter_map(|dto| {
            let overlay = overlay_for(dto);
            if is_ical_dismissed_by_uid_date(dismissed, dto, overlay.as_ref()) {
                ical_visible_row_key(dto)
            } else {
                None
            }
        })
        .collect()
}

fn legacy_ical_series_id(account_id: &str, external_id: &str) -> String {
    crate::gcal::cache::synthetic_event_id(account_id, external_id)
}

fn ical_overlay_for_occurrence(
    state: &State<AppState>,
    occurrence_id: &str,
    legacy_series_id: &str,
    occurrence_date: &str,
) -> Option<ParsedEvent> {
    if let Some(overlay) = state.events_cache.ical_overlay(occurrence_id) {
        return Some(overlay);
    }
    if occurrence_id == legacy_series_id {
        return None;
    }
    state
        .events_cache
        .ical_overlay(legacy_series_id)
        .filter(|overlay| date_part(&overlay.date) == date_part(occurrence_date))
}

fn apply_ical_overlay(dto: &mut EventDto, overlay: ParsedEvent) {
    let mut overridden = false;
    if overlay_overrides(&overlay, "title")
        && !overlay.title.is_empty()
        && overlay.title != dto.title
    {
        dto.title = overlay.title.clone();
        overridden = true;
    }
    if overlay_overrides(&overlay, "duration")
        && overlay.duration != 0
        && overlay.duration != dto.duration
    {
        dto.duration = overlay.duration;
        overridden = true;
    }
    if overlay_overrides(&overlay, "date") && !overlay.date.is_empty() && overlay.date != dto.date {
        if dto.recurring == RecurringRule::None {
            dto.date = overlay.date.clone();
            overridden = true;
        } else if let Some(spliced) = splice_time_of_day(&dto.date, &overlay.date) {
            if spliced != dto.date {
                dto.date = spliced;
                overridden = true;
            }
        }
    }
    if !overlay.body.is_empty() {
        dto.body = overlay.body.clone();
    }
    // Area is user-added metadata (the iCal feed never carries one),
    // so always layer it through — and don't count it as an "override"
    // of upstream, since there's no upstream value to override.
    if !overlay.area.is_empty() {
        dto.area = overlay.area.clone();
    }
    if overridden {
        dto.local_overrides = Some(true);
    }
}

fn overlay_overrides(overlay: &ParsedEvent, field: &str) -> bool {
    overlay
        .local_metadata_overrides
        .iter()
        .any(|override_field| override_field == field)
}

fn parsed_event_from_ical_dto(dto: &EventDto) -> ParsedEvent {
    ParsedEvent {
        id: dto.id.clone(),
        title: dto.title.clone(),
        subtitle: dto.subtitle.clone(),
        date: dto.date.clone(),
        duration: dto.duration,
        area: dto.area.clone(),
        attendees: dto.attendees.clone(),
        recurring: dto.recurring,
        provider: Some(EventProvider::Ical),
        account_id: dto.account_id.clone(),
        external_id: dto.external_id.clone(),
        writable: Some(false),
        rrule_original: dto.rrule_original.clone(),
        local_metadata_overrides: Vec::new(),
        tags: dto.tags.clone(),
        body: dto.body.clone(),
    }
}

fn write_event(
    state: &State<AppState>,
    abs_path: &Path,
    event: &ParsedEvent,
) -> Result<(), String> {
    let serialized = parsers::serialize_event(event).map_err(|e| e.to_string())?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &serialized).map_err(|e| e.to_string())?;
    Ok(())
}

fn index_event_in_search(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    abs_path: &Path,
    event: &ParsedEvent,
) {
    if let Ok(idx) = state.ensure_index(app) {
        let rel = crate::index::rel_path_str(vault, abs_path);
        if let Err(e) = idx.upsert(&crate::index::doc_from_event(event, &rel)) {
            eprintln!("index event {}: {}", event.id, e);
        }
    }
}

fn unindex_event_in_search(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    abs_path: &Path,
    _id: &str,
) {
    // Per-file events: deleting by path removes exactly this event from
    // the search index. In the old inline layout the index keyed by
    // (kind, path) conflated all events on a day, which is why deletes
    // were a no-op there.
    if let Ok(idx) = state.ensure_index(app) {
        let rel = crate::index::rel_path_str(vault, abs_path);
        if let Err(e) = idx.delete_by_path(&rel) {
            eprintln!("unindex event {}: {}", abs_path.display(), e);
        }
    }
}

fn materialize_ical_occurrence_file(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    dto: &EventDto,
) -> Result<(), String> {
    if dto.provider != Some(EventProvider::Ical) {
        return Ok(());
    }
    let abs_path = ical_notes_path(vault, &dto.id)?;
    if abs_path.is_file() {
        return Ok(());
    }
    let event = parsed_event_from_ical_dto(dto);
    write_event(state, &abs_path, &event)?;
    state.events_cache.upsert(abs_path.clone(), event.clone());
    index_event_in_search(app, state, vault, &abs_path, &event);
    Ok(())
}

#[tauri::command]
pub fn event_get(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<Option<EventDto>, String> {
    let vault = vault_root(&app)?;

    // First-choice path: events/<id>.md. The index points at the same
    // place, but going directly to the canonical path avoids a stale-
    // index cycle and keeps event_get correct even if the index missed
    // a watcher tick.
    let abs_path = event_path(&vault, &id)?;
    if abs_path.is_file() {
        let content = vault_lib::read_record(&abs_path).map_err(|e| e.to_string())?;
        let event = parsers::parse_event(&content).map_err(|e| format!("{:#}", e))?;
        if event.id != id {
            return Err(format!(
                "event file {} contains a different id ({})",
                abs_path.display(),
                event.id
            ));
        }
        let mut dto = EventDto::from_parsed(event, &vault, &abs_path);
        enrich_resolved_attendees(&mut dto, &state);
        return Ok(Some(dto));
    }

    // Read fallback: un-migrated vault. The event may still live inline
    // in a daily file the migration hasn't lifted yet. Walk the index.
    if let Some(legacy_path) = state.events_index.get(&id) {
        if legacy_path != abs_path && legacy_path.is_file() {
            if let Some(event) = read_inline_event_from_daily(&legacy_path, &id)? {
                let mut dto = EventDto::from_parsed(event, &vault, &legacy_path);
                enrich_resolved_attendees(&mut dto, &state);
                return Ok(Some(dto));
            }
        }
    }

    state.events_index.remove(&id);
    Ok(None)
}

#[tauri::command]
pub fn event_update(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    update: EventUpdate,
) -> Result<EventDto, String> {
    let vault = vault_root(&app)?;
    let abs_path = event_path(&vault, &id)?;

    let mut event = if abs_path.is_file() {
        let content = vault_lib::read_record(&abs_path).map_err(|e| e.to_string())?;
        parsers::parse_event(&content).map_err(|e| format!("{:#}", e))?
    } else {
        return Err(format!("event not found: {}", id));
    };

    // Read-only enforcement: events synced from an external feed
    // (iCal) are written by the sync orchestrator and reconciled on
    // re-sync — letting the user mutate them would create a divergence
    // the next sync would silently undo. gcal_account_remove is the
    // cleanup path for those events.
    if event.writable == Some(false) {
        return Err("event is read-only (synced from an external calendar)".into());
    }

    if let Some(t) = update.title {
        event.title = t;
    }
    if let Some(s) = update.subtitle {
        event.subtitle = s;
    }
    if let Some(d) = update.date {
        event.date = d;
    }
    if let Some(d) = update.duration {
        event.duration = d;
    }
    if let Some(sp) = update.area {
        event.area = sp;
    }
    if let Some(a) = update.attendees {
        event.attendees = a;
    }
    if let Some(r) = update.recurring {
        event.recurring = r;
    }
    if let Some(b) = update.body {
        event.body = b;
    }
    if let Some(t) = update.tags {
        event.tags = t;
    }

    write_event(&state, &abs_path, &event)?;
    state.events_index.insert(id.clone(), abs_path.clone());
    state.events_cache.upsert(abs_path.clone(), event.clone());
    index_event_in_search(&app, &state, &vault, &abs_path, &event);

    let mut dto = EventDto::from_parsed(event, &vault, &abs_path);
    enrich_resolved_attendees(&mut dto, &state);
    Ok(dto)
}

#[tauri::command]
pub fn event_delete(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let abs_path = event_path(&vault, &id)?;

    if !abs_path.exists() {
        state.events_index.remove(&id);
        return Ok(());
    }

    // Read-only events can't be deleted through this command. iCal-
    // synced events are removed via gcal_account_remove.
    let content = vault_lib::read_record(&abs_path).map_err(|e| e.to_string())?;
    let event = parsers::parse_event(&content).map_err(|e| format!("{:#}", e))?;
    if event.writable == Some(false) {
        return Err("event is read-only (synced from an external calendar)".into());
    }

    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(&abs_path);
    }
    vault_lib::move_to_trash(&vault, &abs_path)?;
    state.events_index.remove(&id);
    state.events_cache.remove_path(&abs_path);
    unindex_event_in_search(&app, &state, &vault, &abs_path, &id);
    Ok(())
}

/// Pull a single event by id from an inline-events daily file. Used by
/// the un-migrated-vault read fallback in `event_get`.
fn read_inline_event_from_daily(
    daily_path: &Path,
    id: &str,
) -> Result<Option<ParsedEvent>, String> {
    let content = vault_lib::read_record(daily_path).map_err(|e| e.to_string())?;
    let daily = parsers::parse_daily(&content).map_err(|e| format!("{:#}", e))?;
    Ok(daily.events.into_iter().find(|e| e.id == id))
}

#[tauri::command]
pub fn events_for_date(
    app: AppHandle,
    state: State<AppState>,
    date: String,
) -> Result<Vec<EventDto>, String> {
    let vault = vault_root(&app)?;
    let target = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .map_err(|e| format!("invalid date {date}: {e}"))?;

    // Hot path: read from the in-memory cache. No directory walk, no YAML
    // parse — events were parsed once at watcher_start and upserted on
    // each create/update/delete.
    let mut out = collect_events_from_cache(&state.events_cache, &vault, target);

    // Read fallback for un-migrated vaults: events that still live inline
    // in `cadence/<date>.md` frontmatter are surfaced here too. The boot
    // migration normally lifts them out, but iCloud-skipped vaults stay
    // on the legacy layout indefinitely. This path is still disk-walked
    // because un-migrated vaults are rare and the cache doesn't track
    // inline events (they're rebuilt into events/ by the migration).
    out.extend(collect_inline_events_from_cadence(&vault, target)?);

    // Merge in iCal events from the in-memory cache. These live in
    // <app_data_dir>/gcal-cache/<account_id>.json rather than in the
    // vault — the per-file approach didn't scale past ~5000 events.
    // For each projection, overlay the user's notes body (if present)
    // from the cache — populated at watcher_start and maintained by
    // event_ical_save_notes.
    //
    // Cross-account dedupe by UID at start-time: a meeting that lives
    // on two of the user's connected calendars (very common when
    // someone has both a personal Gmail and a workspace alias on the
    // same invite) would otherwise show up twice. UID is set by the
    // organizer and shared across recipients, so collapsing on
    // (uid, start) is safe — same UID at the same time = same meeting.
    // Two different occurrences of a recurring event keep distinct
    // start times, so this preserves them as separate rows.
    let dismissed = read_dismissed_uids(&app)?;
    let ical_candidates = state.ical_cache.events_for_date(target);
    let hidden_ical_visible_rows =
        hidden_ical_visible_row_keys(&dismissed, &ical_candidates, |dto| {
            let (Some(account), Some(external)) =
                (dto.account_id.as_deref(), dto.external_id.as_deref())
            else {
                return None;
            };
            let legacy_id = legacy_ical_series_id(account, external);
            ical_overlay_for_occurrence(&state, &dto.id, &legacy_id, &dto.date)
        });
    let mut seen_uid_starts: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    for mut dto in ical_candidates {
        let overlay = if let (Some(account), Some(external)) =
            (dto.account_id.as_deref(), dto.external_id.as_deref())
        {
            let legacy_id = legacy_ical_series_id(account, external);
            ical_overlay_for_occurrence(&state, &dto.id, &legacy_id, &dto.date)
        } else {
            None
        };
        if is_ical_dismissed_by_uid_date(&dismissed, &dto, overlay.as_ref()) {
            continue;
        }
        if ical_visible_row_key(&dto).is_some_and(|key| hidden_ical_visible_rows.contains(&key)) {
            continue;
        }
        if let Some(uid) = dto.external_id.as_deref() {
            if !seen_uid_starts.insert((uid.to_string(), dto.date.clone())) {
                continue;
            }
        }
        // Layer occurrence-scoped local metadata/notes. Legacy
        // series-level files are used only on the occurrence whose
        // frontmatter date they actually describe, so last week's
        // meeting notes don't bleed into this week's row.
        if let Some(overlay) = overlay {
            apply_ical_overlay(&mut dto, overlay);
        }
        out.push(dto);
    }

    // Sort by absolute instant, not by raw string. iCal events store as
    // UTC (`+00:00`) while vault-local events use the local offset, so
    // `13:00:00-07:00` (1pm PDT) would lex-sort before `14:00:00+00:00`
    // (7am PDT) — putting PM events ahead of AM events on the schedule.
    out.sort_by(|a, b| {
        let ai = parse_event_date(&a.date).map(|d| d.timestamp());
        let bi = parse_event_date(&b.date).map(|d| d.timestamp());
        ai.cmp(&bi).then_with(|| a.date.cmp(&b.date))
    });

    // Cross-source dedupe: collapse rows that share both title and
    // start timestamp. The per-source (uid, date_string) dedupe above
    // misses the common case where the same meeting lives on two of
    // the user's connected calendars under different UIDs, or where
    // timezone-string formatting differs by a single character. Same
    // title at the same exact second is, in practice, the same event.
    // Different start times are preserved — back-to-back blocks with
    // identical names stay as separate rows.
    {
        let mut seen: std::collections::HashSet<(String, i64)> = std::collections::HashSet::new();
        out.retain(|dto| {
            let Some(ts) = parse_event_date(&dto.date).map(|d| d.timestamp()) else {
                return true;
            };
            let key = (dto.title.trim().to_lowercase(), ts);
            seen.insert(key)
        });
    }

    // Materialize only the rows that survived dismissals and dedupe.
    // This keeps sync cheap while still giving each visited cadence
    // day concrete event files in the vault.
    for dto in &out {
        materialize_ical_occurrence_file(&app, &state, &vault, dto)?;
    }

    // Single enrichment pass: turn raw attendee strings into
    // `AttendeeDto` rows with optional person matches. Done once
    // here rather than inside every DTO builder so the people-email
    // index only needs to be held by the top-level commands.
    for dto in out.iter_mut() {
        enrich_resolved_attendees(dto, &state);
    }
    Ok(out)
}

/// Populate `dto.resolved_attendees` from `dto.attendees` using the
/// in-memory people-email index. Each raw entry yields exactly one
/// `AttendeeDto`, so the two arrays stay aligned by index — the
/// frontend can iterate either and pair them when needed.
///
/// Resolution rules:
///
///   - iCal events (and any DTO that has `external_id` set): the raw
///     entry is an email. Try `lookup_email`. Fallback display label
///     is the email itself.
///   - Vault-local events: the raw entry is a person id (slug). Try
///     `lookup_id`. Fallback display label is the raw id (so a
///     stale reference doesn't render blank).
///
/// Infer an event's area from its attendees. A matched person votes
/// their own area; an unmatched iCal attendee votes their email
/// domain's area (corporate domains only — generic free-mail providers
/// never map to an area). Returns the most-voted area, ties broken by
/// area id for determinism, or `None` when no attendee carries one.
///
/// Pure read-time inference: callers use it to fill a DTO's `area` for
/// display when the file on disk has none. Nothing is written — the
/// moment the user pins an area explicitly, that value wins on the next
/// read and the inference no longer applies.
pub(crate) fn infer_area_from_attendees(
    attendees: &[String],
    is_external: bool,
    idx: &crate::state::PeopleEmailIndex,
) -> Option<String> {
    use std::collections::HashMap;
    let mut votes: HashMap<String, usize> = HashMap::new();
    for raw in attendees {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        // iCal attendees are emails (person match, then domain fallback);
        // vault-local attendees are person ids (id match only).
        let area = if is_external {
            idx.lookup_email(trimmed)
                .and_then(|p| p.area)
                .or_else(|| idx.lookup_domain_area(trimmed))
        } else {
            idx.lookup_id(trimmed).and_then(|p| p.area)
        };
        if let Some(area) = area {
            let area = area.trim().to_string();
            if !area.is_empty() {
                *votes.entry(area).or_default() += 1;
            }
        }
    }
    votes
        .into_iter()
        .max_by(|(a_area, a_n), (b_area, b_n)| a_n.cmp(b_n).then_with(|| b_area.cmp(a_area)))
        .map(|(area, _)| area)
}

pub(crate) fn enrich_resolved_attendees(dto: &mut EventDto, state: &State<AppState>) {
    let is_external = dto.external_id.is_some();
    let idx = &state.people_email_index;
    dto.resolved_attendees = dto
        .attendees
        .iter()
        .map(|raw| {
            let trimmed = raw.trim();
            let matched = if is_external {
                idx.lookup_email(trimmed)
            } else {
                idx.lookup_id(trimmed)
            };
            match matched {
                Some(person) => AttendeeDto {
                    raw: raw.clone(),
                    person_id: Some(person.id),
                    name: person.name,
                    email: person.email,
                },
                None => AttendeeDto {
                    raw: raw.clone(),
                    person_id: None,
                    // For iCal entries the raw value IS the email
                    // already; for vault-local it's a person id with
                    // no email available, so we just surface the raw
                    // value as the display label.
                    name: trimmed.to_string(),
                    email: if is_external {
                        Some(trimmed.to_string())
                    } else {
                        None
                    },
                },
            }
        })
        .collect();

    // Fill the area from the attendees when the file carries none. iCal
    // events never arrive with an upstream area, and vault-local events
    // can be created without one; rather than render "Empty", borrow the
    // area most attendees belong to. Display-only — see
    // `infer_area_from_attendees`.
    if dto.area.trim().is_empty() {
        if let Some(area) = infer_area_from_attendees(&dto.attendees, is_external, idx) {
            dto.area = area;
        }
    }
}

/// Read-side query against the in-memory events cache. Pulls the date's
/// non-recurring bucket directly; scans the small recurring list and
/// projects each one through `occurrence_for`.
fn collect_events_from_cache(
    cache: &EventsCache,
    vault: &Path,
    target: NaiveDate,
) -> Vec<EventDto> {
    let (non_recurring, recurring) = cache.snapshot_for_date(target);
    let mut out: Vec<EventDto> = non_recurring
        .into_iter()
        .map(|c| EventDto::from_parsed(c.event, vault, &c.path))
        .collect();
    for entry in recurring {
        if let Some(occurrence_date) = occurrence_for(&entry.event, target) {
            let mut dto = EventDto::from_parsed(entry.event, vault, &entry.path);
            dto.date = occurrence_date;
            out.push(dto);
        }
    }
    out
}

/// Read fallback: events still living inline in `cadence/<date>.md`
/// frontmatter. Boot migration usually drains this, but vaults skipped
/// for being iCloud-synced stay on the legacy layout.
fn collect_inline_events_from_cadence(
    vault: &Path,
    target: NaiveDate,
) -> Result<Vec<EventDto>, String> {
    let dir = vault_lib::cadence_dir(vault);
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
        let filename = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => continue,
        };
        if NaiveDate::parse_from_str(filename, "%Y-%m-%d").is_err() {
            continue;
        }
        let content = match vault_lib::read_record(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let daily = match parsers::parse_daily(&content) {
            Ok(d) => d,
            Err(_) => continue,
        };
        if daily.events.is_empty() {
            continue;
        }
        for event in daily.events {
            if let Some(occurrence_date) = occurrence_for(&event, target) {
                let mut dto = EventDto::from_parsed(event, vault, &path);
                dto.date = occurrence_date;
                out.push(dto);
            }
        }
    }
    Ok(out)
}

/// Parse an event date string into a date+time. Tolerates RFC3339 with
/// offset (what we serialize) and naive `YYYY-MM-DDTHH:MM:SS` (what older
/// mock data and external editors may produce).
fn parse_event_date(s: &str) -> Option<DateTime<FixedOffset>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt);
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        let offset = FixedOffset::east_opt(0)?;
        return offset.from_local_datetime(&naive).single();
    }
    None
}

/// If the event occurs on `target` (literal date or expanded recurrence),
/// return the projected occurrence's ISO datetime. None otherwise.
fn occurrence_for(event: &ParsedEvent, target: NaiveDate) -> Option<String> {
    project_occurrence(&event.date, event.recurring, target)
}

/// Date-projection primitive. Shared between the file-backed vault
/// event scan and the iCal cache lookup so both honor the same
/// recurrence semantics. Takes a raw RFC3339-ish date string +
/// recurring rule + target day, returns the projected RFC3339
/// occurrence (or None if the event doesn't fall on `target`).
pub fn project_occurrence(
    date_str: &str,
    recurring: RecurringRule,
    target: NaiveDate,
) -> Option<String> {
    let dt = parse_event_date(date_str)?;
    let event_date_local = dt.with_timezone(&chrono::Local).date_naive();

    let matches = match recurring {
        RecurringRule::None => event_date_local == target,
        RecurringRule::Daily => target >= event_date_local,
        RecurringRule::Weekly => {
            target >= event_date_local && target.weekday() == event_date_local.weekday()
        }
        RecurringRule::Monthly => {
            target >= event_date_local && target.day() == event_date_local.day()
        }
    };
    if !matches {
        return None;
    }
    if event_date_local == target {
        return Some(date_str.to_string());
    }
    // Anchor the projection to the master's wall-clock time in the *user's*
    // local timezone (DST-aware), not its captured fixed offset. A meeting
    // created at 8:30 AM PST should stay 8:30 AM in PDT — using the master's
    // -08:00 offset across a DST boundary would slide it to 9:30. Fall back
    // to the master's fixed offset only when local re-anchoring is ambiguous
    // (the once-a-year fall-back hour) so the projection still produces *a*
    // value.
    let local_time = dt.with_timezone(&chrono::Local).time();
    let projected_naive = target.and_time(local_time);
    if let chrono::LocalResult::Single(zoned) = chrono::Local.from_local_datetime(&projected_naive)
    {
        return Some(zoned.with_timezone(dt.offset()).to_rfc3339());
    }
    let fallback = dt.offset().from_local_datetime(&projected_naive).single()?;
    Some(fallback.to_rfc3339())
}

/// Rebuild the id → event-file path map AND the date-bucketed events cache.
/// Scans `events/` first; falls back to `cadence/` daily files for any vault
/// that hasn't completed the boot migration (iCloud-skipped vaults, etc.).
/// Called on startup (from watcher_start) and on every external write under
/// either dir. The cache is cleared at the start of each rebuild so external
/// deletes don't leave phantom entries.
pub fn rebuild_index(vault: &Path, index: &EventIndex, cache: &EventsCache) -> Result<(), String> {
    index.clear();
    cache.clear();
    index_events_dir(vault, index, cache)?;
    index_inline_events_in_cadence(vault, index)?;
    Ok(())
}

fn index_events_dir(vault: &Path, index: &EventIndex, cache: &EventsCache) -> Result<(), String> {
    let dir = vault_lib::events_dir(vault);
    if !vault_lib::is_real_directory(&dir) {
        return Ok(());
    }
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
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
        let event = match parsers::parse_event(&content) {
            Ok(e) => e,
            Err(_) => continue,
        };
        index.insert(event.id.clone(), path.clone());
        cache.upsert(path, event);
    }
    Ok(())
}

/// Read a single iCal event's merged view: metadata from the cache,
/// body from the notes attachment if one exists. Returns `None` if no
/// matching event is in the cache (e.g. the calendar was removed or
/// the user disconnected the account before opening the saved note).
#[tauri::command]
pub fn event_ical_get(
    app: AppHandle,
    state: State<AppState>,
    account_id: String,
    external_id: String,
    occurrence_date: Option<String>,
) -> Result<Option<EventDto>, String> {
    let vault = vault_root(&app)?;
    let occurrence_target = occurrence_date
        .as_deref()
        .map(normalize_occurrence_date)
        .transpose()?;
    let ev = match state.ical_cache.find_event(&account_id, &external_id) {
        Some(ev) => ev,
        None => return Ok(None),
    };
    let legacy_id = legacy_ical_series_id(&account_id, &external_id);
    let mut dto = if let Some(target) = occurrence_target {
        match state
            .ical_cache
            .event_for_date(&account_id, &external_id, target)
        {
            Some(projected) => projected,
            None => return Ok(None),
        }
    } else {
        let description = crate::gcal::clean::clean_description(&ev.description);
        let meeting_url =
            crate::gcal::clean::extract_meeting_url(&ev.description, ev.location.as_deref());
        EventDto {
            id: legacy_id.clone(),
            path: String::new(),
            title: if ev.summary.is_empty() {
                "(no title)".into()
            } else {
                ev.summary.clone()
            },
            subtitle: ev.location,
            date: ev.dtstart_rfc3339,
            duration: ev.duration_minutes,
            area: String::new(),
            attendees: ev.attendees.iter().map(|a| a.email.clone()).collect(),
            resolved_attendees: Vec::new(),
            recurring: ev.recurring_enum,
            provider: Some(EventProvider::Ical),
            account_id: Some(account_id.clone()),
            external_id: Some(external_id.clone()),
            writable: Some(false),
            rrule_original: ev.rrule_original,
            tags: Vec::new(),
            description: if description.is_empty() {
                None
            } else {
                Some(description)
            },
            meeting_url,
            local_overrides: None,
            body: String::new(),
        }
    };
    let dismissed = read_dismissed_uids(&app)?;
    let overlay = ical_overlay_for_occurrence(&state, &dto.id, &legacy_id, &dto.date);
    if occurrence_date.is_some() {
        if is_ical_dismissed_by_uid_date(&dismissed, &dto, overlay.as_ref()) {
            return Ok(None);
        }
    } else if is_dismissed(&dismissed, Some(&account_id), Some(&external_id), None) {
        // Deep links without an occurrence date can only represent a
        // legacy series-level hide. Per-occurrence hides intentionally
        // leave the detail route resolvable for sibling occurrences.
        return Ok(None);
    }
    if let Some(overlay) = overlay {
        apply_ical_overlay(&mut dto, overlay);
    }
    let dto_path = ical_notes_path(&vault, &dto.id)?;
    dto.path = dto_path
        .strip_prefix(&vault)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    if occurrence_date.is_some() {
        materialize_ical_occurrence_file(&app, &state, &vault, &dto)?;
    }
    enrich_resolved_attendees(&mut dto, &state);
    Ok(Some(dto))
}

/// Save (or update) the local markdown file for one iCal occurrence.
/// First write creates `events/<occurrence_id>.md` carrying the
/// event's metadata snapshotted from the cache + whichever fields the
/// patch overrides + body. Subsequent writes merge into that same
/// occurrence file. The gcal cache is never modified.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri exposes these as named IPC arguments.
pub fn event_ical_save_notes(
    app: AppHandle,
    state: State<AppState>,
    account_id: String,
    external_id: String,
    occurrence_date: Option<String>,
    body: Option<String>,
    title: Option<String>,
    date: Option<String>,
    duration: Option<u32>,
    area: Option<String>,
) -> Result<EventDto, String> {
    let vault = vault_root(&app)?;
    let ev = state
        .ical_cache
        .find_event(&account_id, &external_id)
        .ok_or_else(|| {
            format!(
                "iCal event {} not found in account {}",
                external_id, account_id
            )
        })?;
    let occurrence_target = occurrence_date
        .as_deref()
        .map(normalize_occurrence_date)
        .transpose()?;
    let legacy_id = legacy_ical_series_id(&account_id, &external_id);
    let cache_dto = if let Some(target) = occurrence_target {
        state
            .ical_cache
            .event_for_date(&account_id, &external_id, target)
            .ok_or_else(|| {
                format!(
                    "iCal event {} does not occur on {}",
                    external_id,
                    target.format("%Y-%m-%d")
                )
            })?
    } else {
        EventDto {
            id: legacy_id.clone(),
            path: String::new(),
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
            resolved_attendees: Vec::new(),
            recurring: ev.recurring_enum,
            provider: Some(EventProvider::Ical),
            account_id: Some(account_id.clone()),
            external_id: Some(external_id.clone()),
            writable: Some(false),
            rrule_original: ev.rrule_original.clone(),
            tags: Vec::new(),
            description: None,
            meeting_url: None,
            local_overrides: None,
            body: String::new(),
        }
    };
    let abs_path = ical_notes_path(&vault, &cache_dto.id)?;

    // Base the new file on the existing overlay if one's already on
    // disk — that way successive saves layer correctly and we don't
    // clobber a previously-overridden title when the user only edits
    // the date. Fall back to a fresh snapshot from the gcal cache.
    let base = ical_overlay_for_occurrence(&state, &cache_dto.id, &legacy_id, &cache_dto.date);

    // Visiting an event page must never create its notes file. A frontend
    // no-op commit (empty body, no field overrides) used to materialize
    // `events/<occurrence_id>.md` for every event the user merely opened.
    // Only a real edit — body content or a field override — creates one.
    let body_is_blank = body.as_deref().map_or(true, |b| b.trim().is_empty());
    if base.is_none()
        && body_is_blank
        && title.is_none()
        && date.is_none()
        && duration.is_none()
        && area.as_deref().map_or(true, |a| a.trim().is_empty())
    {
        return event_ical_get(app, state, account_id, external_id, occurrence_date)?
            .ok_or_else(|| "event vanished from cache".to_string());
    }

    // Same protection as daily_save: refuse to replace substantial meeting
    // notes with nothing — the notes body runs through the same frontend
    // editor machinery that once wiped a daily journal.
    if let (Some(next), Some(existing)) = (body.as_deref(), base.as_ref()) {
        if crate::commands::daily::is_destructive_overwrite(&existing.body, next) {
            crate::log_warn!(
                "event::ical_save",
                "refused empty-body overwrite of {} (existing notes {} bytes)",
                cache_dto.id,
                existing.body.len()
            );
            return Err(format!(
                "refusing to overwrite meeting notes for {} with an empty body; edit the file directly to clear it",
                cache_dto.id
            ));
        }
    }

    let title_overridden = title.is_some();
    let date_overridden = date.is_some();
    let duration_overridden = duration.is_some();
    let mut local_metadata_overrides = base
        .as_ref()
        .map(|b| b.local_metadata_overrides.clone())
        .unwrap_or_default();
    if title_overridden {
        push_metadata_override(&mut local_metadata_overrides, "title");
    }
    if date_overridden {
        push_metadata_override(&mut local_metadata_overrides, "date");
    }
    if duration_overridden {
        push_metadata_override(&mut local_metadata_overrides, "duration");
    }

    let event = ParsedEvent {
        id: cache_dto.id.clone(),
        title: title
            .or_else(|| base.as_ref().map(|b| b.title.clone()))
            .unwrap_or_else(|| cache_dto.title.clone()),
        subtitle: cache_dto.subtitle.clone(),
        date: date
            .or_else(|| base.as_ref().map(|b| b.date.clone()))
            .unwrap_or_else(|| cache_dto.date.clone()),
        duration: duration
            .or_else(|| base.as_ref().map(|b| b.duration))
            .unwrap_or(cache_dto.duration),
        // Area is iCal-specific: the upstream feed doesn't carry one,
        // so the user assigns it locally. Preserve the overlay's area
        // across saves that only edit other fields; default to empty
        // when no overlay yet exists.
        area: area
            .or_else(|| base.as_ref().map(|b| b.area.clone()))
            .unwrap_or_default(),
        attendees: cache_dto.attendees.clone(),
        recurring: cache_dto.recurring,
        provider: Some(EventProvider::Ical),
        account_id: Some(account_id.clone()),
        external_id: Some(external_id.clone()),
        // writable=false signals "no write-back to the upstream calendar"
        // (gcal OAuth is Phase 2b). Local edits land in this file
        // regardless; the frontend gates the popover by the absence of
        // the iCal-detail-specific guard, not by writable.
        writable: Some(false),
        rrule_original: cache_dto.rrule_original.clone(),
        local_metadata_overrides,
        tags: cache_dto.tags.clone(),
        body: body
            .or_else(|| base.as_ref().map(|b| b.body.clone()))
            .unwrap_or_default(),
    };
    write_event(&state, &abs_path, &event)?;
    state.events_cache.upsert(abs_path.clone(), event.clone());
    index_event_in_search(&app, &state, &vault, &abs_path, &event);

    // Re-read through event_ical_get so the returned DTO carries the
    // merged view (including local_overrides flag) — keeps the cache
    // and the frontend in lockstep.
    event_ical_get(
        app,
        state,
        event.account_id.clone().unwrap_or_default(),
        event.external_id.clone().unwrap_or_default(),
        occurrence_date,
    )?
    .ok_or_else(|| "event vanished from cache after save".to_string())
}

fn push_metadata_override(overrides: &mut Vec<String>, field: &str) {
    if !overrides.iter().any(|existing| existing == field) {
        overrides.push(field.to_string());
    }
}

/// Accept either a bare `YYYY-MM-DD` or an RFC3339 datetime prefix.
/// Only the date portion matters for recurrence projection.
fn normalize_occurrence_date(s: &str) -> Result<NaiveDate, String> {
    let s = s.trim();
    if s.len() >= 10 {
        let date = &s[..10];
        if let Ok(parsed) = NaiveDate::parse_from_str(date, "%Y-%m-%d") {
            return Ok(parsed);
        }
    }
    Err(format!(
        "invalid occurrenceDate {s:?} — expected YYYY-MM-DD"
    ))
}

fn index_inline_events_in_cadence(vault: &Path, index: &EventIndex) -> Result<(), String> {
    let dir = vault_lib::cadence_dir(vault);
    if !vault_lib::is_real_directory(&dir) {
        return Ok(());
    }
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !vault_lib::is_real_file(&path)
        {
            continue;
        }
        let filename = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => continue,
        };
        if NaiveDate::parse_from_str(filename, "%Y-%m-%d").is_err() {
            continue;
        }
        let content = match vault_lib::read_record(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let daily = match parsers::parse_daily(&content) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for event in &daily.events {
            // Don't shadow events/ entries (the canonical home wins);
            // only register inline events that aren't already accounted
            // for as a standalone file. This makes the read-fallback
            // robust against half-migrated vaults.
            if index.get(&event.id).is_none() {
                index.insert(event.id.clone(), path.clone());
            }
        }
    }
    Ok(())
}

/// Compose the projection's date with the overlay's time-of-day. Used
/// to apply a recurring iCal event's local override (which carries a
/// single date) to each projected occurrence — each Wednesday keeps
/// its own date but adopts the user's intended start time.
///
/// Critical: the output uses the OVERLAY's offset, not the
/// projection's. iCal feeds frequently serve recurring events with a
/// UTC dtstart, and the overlay carries the user's local zone (from
/// combineDateTime in the frontend). Applying overlay.hour() naively
/// to a UTC projection would mean "08 in UTC" = 01:00 PDT — a 7-hour
/// drift in the worst case. By reinterpreting in the overlay's offset
/// we get the user's intended wall-clock anchored to their local zone.
///
/// DST caveat: the overlay carries a fixed offset (e.g. -08:00 PST)
/// captured at edit time. Projections that cross a DST boundary will
/// show a 1-hour drift in the user's *display* zone (8:30 PST shows
/// as 9:30 PDT). Properly fixing that needs an IANA zone identifier
/// on the override file, which we'd surface alongside an explicit
/// "wall clock vs UTC moment" choice. Tracked as future work; for
/// now bounded and explainable beats wildly wrong.
///
/// Returns None if either side fails to parse; the caller leaves the
/// projection alone.
fn splice_time_of_day(projection_rfc3339: &str, overlay_rfc3339: &str) -> Option<String> {
    let projection = DateTime::parse_from_rfc3339(projection_rfc3339).ok()?;
    let overlay = DateTime::parse_from_rfc3339(overlay_rfc3339).ok()?;
    let projection_date = projection.with_timezone(overlay.offset()).date_naive();
    let spliced_naive = projection_date.and_time(overlay.time());
    let spliced = overlay
        .offset()
        .from_local_datetime(&spliced_naive)
        .single()?;
    Some(spliced.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::daily;
    use crate::parsers::DailyJournal;
    use crate::vault::VAULT_SUBDIRS;
    use chrono::Timelike;
    use tempfile::TempDir;

    #[test]
    fn splice_time_of_day_keeps_projection_date_at_overlay_offset() {
        // Same-offset case: overlay and projection both in -05:00.
        // Result is Feb 25 at the overlay's HH:MM in the overlay's offset.
        let projection = "2026-02-25T09:30:00-05:00";
        let overlay = "2026-02-18T08:30:00-05:00";
        let spliced = splice_time_of_day(projection, overlay).unwrap();
        let dt = DateTime::parse_from_rfc3339(&spliced).unwrap();
        assert_eq!(dt.month(), 2);
        assert_eq!(dt.day(), 25);
        assert_eq!(dt.hour(), 8);
        assert_eq!(dt.minute(), 30);
        assert_eq!(dt.offset().local_minus_utc(), -5 * 3600);
    }

    #[test]
    fn splice_time_of_day_uses_overlay_offset_not_projection() {
        // Projection in UTC (typical Google feed), overlay in PST.
        // Output must use the OVERLAY's offset so a "8:30 PST" edit
        // doesn't get interpreted as "8:30 UTC" (which would display
        // as 12:30 AM in the user's PST/PDT zone).
        let projection = "2026-05-13T16:30:00+00:00";
        let overlay = "2026-02-18T08:30:00-08:00";
        let spliced = splice_time_of_day(projection, overlay).unwrap();
        let dt = DateTime::parse_from_rfc3339(&spliced).unwrap();
        assert_eq!(dt.day(), 13);
        assert_eq!(dt.hour(), 8);
        assert_eq!(dt.minute(), 30);
        assert_eq!(dt.offset().local_minus_utc(), -8 * 3600);
    }

    #[test]
    fn splice_time_of_day_returns_none_for_garbage_input() {
        assert!(splice_time_of_day("not-a-date", "2026-02-18T08:30:00-05:00").is_none());
        assert!(splice_time_of_day("2026-02-25T09:30:00-05:00", "garbage").is_none());
    }

    fn dismissed_with(
        account: &str,
        legacy_uids: &[&str],
        occurrences: &[(&str, &str)],
    ) -> DismissedSet {
        use std::collections::{HashMap, HashSet};
        let mut uids: HashMap<String, HashSet<String>> = HashMap::new();
        let mut occs: HashMap<String, HashSet<(String, String)>> = HashMap::new();
        if !legacy_uids.is_empty() {
            uids.insert(
                account.to_string(),
                legacy_uids.iter().map(|s| s.to_string()).collect(),
            );
        }
        if !occurrences.is_empty() {
            occs.insert(
                account.to_string(),
                occurrences
                    .iter()
                    .map(|(u, d)| (u.to_string(), d.to_string()))
                    .collect(),
            );
        }
        DismissedSet {
            uids,
            occurrences: occs,
        }
    }

    #[test]
    fn per_occurrence_dismiss_hides_only_that_date() {
        // Synthetic regression shape: weekly Tue/Thu master at
        // `series_demo_R20260505T154500@example.test` projects to May 5,
        // May 7, May 12. User clicks Hide on the May 5 row. Only
        // May 5 should be hidden — May 7 and May 12 keep showing.
        let uid = "series_demo_R20260505T154500@example.test";
        let d = dismissed_with("gcal_A", &[], &[(uid, "2026-05-05")]);

        // The dismissed (uid, date) tuple is hidden.
        assert!(is_dismissed(
            &d,
            Some("gcal_A"),
            Some(uid),
            Some("2026-05-05T15:45:00+00:00"),
        ));
        // Sibling Thursday of the same master: still visible.
        assert!(!is_dismissed(
            &d,
            Some("gcal_A"),
            Some(uid),
            Some("2026-05-07T15:45:00+00:00"),
        ));
        // Following Tuesday of the same master: still visible.
        assert!(!is_dismissed(
            &d,
            Some("gcal_A"),
            Some(uid),
            Some("2026-05-12T15:45:00+00:00"),
        ));
    }

    #[test]
    fn per_occurrence_dismiss_does_not_affect_sibling_phases() {
        // User dismisses one occurrence (May 5) on Google's split
        // phase A. A sibling phase B with a different `_R<datetime>`
        // suffix projects onto May 14 — must keep showing.
        let phase_a = "series_demo_R20260505T154500@example.test";
        let phase_b = "series_demo_R20260512T154500@example.test";
        let d = dismissed_with("gcal_A", &[], &[(phase_a, "2026-05-05")]);

        assert!(!is_dismissed(
            &d,
            Some("gcal_A"),
            Some(phase_b),
            Some("2026-05-14T15:45:00+00:00"),
        ));
    }

    #[test]
    fn legacy_uid_dismiss_still_hides_deep_links_without_occurrence() {
        // A route without an occurrence date can only represent the
        // legacy whole-UID hide, so keep blocking that direct open.
        let uid = "legacy@google.com";
        let d = dismissed_with("gcal_A", &[uid], &[]);
        assert!(is_dismissed(&d, Some("gcal_A"), Some(uid), None));
    }

    #[test]
    fn legacy_uid_dismiss_does_not_hide_recurring_schedule_rows() {
        // Old builds wrote whole-UID hides for recurring meetings.
        // Treating those as permanent series hides makes active Google
        // Calendar rows disappear forever, so schedule projection now
        // ignores them for recurring candidates.
        let uid = "legacy-recurring@google.com";
        let d = dismissed_with("gcal_A", &[uid], &[]);
        let mut dto = ical_dto(
            "e_gcal_legacy_20260604",
            uid,
            "Project Standup",
            "2026-06-04T15:45:00+00:00",
        );
        dto.recurring = RecurringRule::Weekly;
        assert!(!is_ical_dismissed_by_uid_date(&d, &dto, None));
    }

    #[test]
    fn legacy_uid_dismiss_still_hides_one_off_schedule_rows() {
        let uid = "legacy-one-off@google.com";
        let d = dismissed_with("gcal_A", &[uid], &[]);
        let dto = ical_dto(
            "e_gcal_one_off_20260604",
            uid,
            "One-off",
            "2026-06-04T15:45:00+00:00",
        );
        assert!(is_ical_dismissed_by_uid_date(&d, &dto, None));
    }

    #[test]
    fn per_occurrence_normalizes_rfc3339_to_date_part() {
        // Filter accepts both `YYYY-MM-DD` and an RFC3339 datetime;
        // only the date portion is compared. Lets the caller pass
        // the projection's `dto.date` verbatim.
        let uid = "x@google.com";
        let d = dismissed_with("gcal_A", &[], &[(uid, "2026-05-05")]);
        assert!(is_dismissed(
            &d,
            Some("gcal_A"),
            Some(uid),
            Some("2026-05-05T20:30:00-07:00"),
        ));
        // Different date in the same RFC3339 → not hidden.
        assert!(!is_dismissed(
            &d,
            Some("gcal_A"),
            Some(uid),
            Some("2026-05-06T20:30:00-07:00"),
        ));
    }

    fn ical_dto(id: &str, uid: &str, title: &str, date: &str) -> EventDto {
        EventDto {
            id: id.to_string(),
            path: format!("gcal-cache/gcal_A/{id}"),
            title: title.to_string(),
            subtitle: None,
            date: date.to_string(),
            duration: 30,
            area: String::new(),
            attendees: Vec::new(),
            resolved_attendees: Vec::new(),
            recurring: RecurringRule::None,
            provider: Some(EventProvider::Ical),
            account_id: Some("gcal_A".to_string()),
            external_id: Some(uid.to_string()),
            writable: Some(false),
            rrule_original: None,
            tags: Vec::new(),
            description: None,
            meeting_url: None,
            local_overrides: None,
            body: String::new(),
        }
    }

    fn ical_overlay(id: &str, uid: &str, title: &str, date: &str) -> ParsedEvent {
        ParsedEvent {
            id: id.to_string(),
            title: title.to_string(),
            subtitle: None,
            date: date.to_string(),
            duration: 30,
            area: String::new(),
            attendees: Vec::new(),
            recurring: RecurringRule::None,
            provider: Some(EventProvider::Ical),
            account_id: Some("gcal_A".to_string()),
            external_id: Some(uid.to_string()),
            writable: Some(false),
            rrule_original: None,
            local_metadata_overrides: Vec::new(),
            tags: Vec::new(),
            body: String::new(),
        }
    }

    #[test]
    fn unmarked_ical_snapshot_does_not_override_current_cache_metadata() {
        let uid = "agents-qa@google.com";
        let mut dto = ical_dto(
            "e_gcal_agents_20260604",
            uid,
            "Agents QA",
            "2026-06-04T19:30:00+00:00",
        );
        dto.duration = 45;
        let mut overlay = ical_overlay(
            "e_gcal_agents_20260604",
            uid,
            "Agents QA",
            "2026-06-04T14:15:00+00:00",
        );
        overlay.duration = 45;
        overlay.area = "acme".to_string();
        overlay.body = "Notes from this occurrence.".to_string();

        apply_ical_overlay(&mut dto, overlay);

        assert_eq!(dto.date, "2026-06-04T19:30:00+00:00");
        assert_eq!(dto.duration, 45);
        assert_eq!(dto.area, "acme");
        assert_eq!(dto.body, "Notes from this occurrence.");
        assert_eq!(dto.local_overrides, None);
    }

    #[test]
    fn marked_ical_metadata_override_still_applies() {
        let uid = "agents-qa@google.com";
        let mut dto = ical_dto(
            "e_gcal_agents_20260604",
            uid,
            "Agents QA",
            "2026-06-04T19:30:00+00:00",
        );
        let mut overlay = ical_overlay(
            "e_gcal_agents_20260604",
            uid,
            "Agents QA",
            "2026-06-04T14:15:00+00:00",
        );
        overlay.local_metadata_overrides = vec!["date".to_string()];

        apply_ical_overlay(&mut dto, overlay);

        assert_eq!(dto.date, "2026-06-04T14:15:00+00:00");
        assert_eq!(dto.local_overrides, Some(true));
    }

    #[test]
    fn per_occurrence_dismiss_ignores_stale_snapshot_time() {
        let uid = "agents-qa@google.com";
        let dismissed = dismissed_with("gcal_A", &[], &[(uid, "2026-06-04")]);
        let dto = ical_dto(
            "e_gcal_agents_20260604",
            uid,
            "Agents QA",
            "2026-06-04T19:30:00+00:00",
        );
        let overlay = ical_overlay(
            "e_gcal_agents_20260604",
            uid,
            "Agents QA",
            "2026-06-04T14:15:00+00:00",
        );

        assert!(!is_ical_dismissed_by_uid_date(
            &dismissed,
            &dto,
            Some(&overlay),
        ));
    }

    #[test]
    fn dismissed_ical_duplicate_hides_equivalent_visible_row() {
        // Google can emit two UIDs for what Woodshed displays as one
        // row (same title and same instant). If the visible UID is
        // dismissed, the duplicate UID must not resurrect the row.
        let dismissed_uid = "eng-ai_R20260423T150000@google.com";
        let duplicate_uid = "eng-ai_R20260521T150000@google.com";
        let dismissed = dismissed_with("gcal_A", &[], &[(dismissed_uid, "2026-05-21")]);
        let hidden = hidden_ical_visible_row_keys(
            &dismissed,
            [
                ical_dto(
                    "e_gcal_a_20260521",
                    dismissed_uid,
                    "Eng AI weekly",
                    "2026-05-21T15:00:00+00:00",
                ),
                ical_dto(
                    "e_gcal_b_20260521",
                    duplicate_uid,
                    "Eng AI weekly",
                    "2026-05-21T15:00:00+00:00",
                ),
            ]
            .iter(),
            |_| None::<ParsedEvent>,
        );
        let duplicate = ical_dto(
            "e_gcal_b_20260521",
            duplicate_uid,
            "Eng AI weekly",
            "2026-05-21T15:00:00+00:00",
        );

        assert!(!is_ical_dismissed_by_uid_date(&dismissed, &duplicate, None));
        assert!(ical_visible_row_key(&duplicate).is_some_and(|key| hidden.contains(&key)));
    }

    #[test]
    fn is_dismissed_requires_both_account_and_external_id() {
        let d = dismissed_with("gcal_A", &["x@google.com"], &[]);
        assert!(!is_dismissed(
            &d,
            None,
            Some("x@google.com"),
            Some("2026-05-05")
        ));
        assert!(!is_dismissed(&d, Some("gcal_A"), None, Some("2026-05-05")));
        assert!(!is_dismissed(&d, None, None, None));
    }

    #[test]
    fn is_dismissed_with_no_date_only_consults_legacy_uid_set() {
        // event_ical_get can't know which occurrence a URL refers to,
        // so it passes None for the date. Per-occurrence dismissals
        // shouldn't block the detail page from opening.
        let uid = "x@google.com";
        let per_occ = dismissed_with("gcal_A", &[], &[(uid, "2026-05-05")]);
        assert!(!is_dismissed(&per_occ, Some("gcal_A"), Some(uid), None));
        // Legacy whole-UID dismissal still blocks the detail page.
        let whole = dismissed_with("gcal_A", &[uid], &[]);
        assert!(is_dismissed(&whole, Some("gcal_A"), Some(uid), None));
    }

    fn setup_vault() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        for sub in VAULT_SUBDIRS {
            std::fs::create_dir_all(vault.join(sub)).unwrap();
        }
        (tmp, vault)
    }

    /// Write a standalone event file at `events/<id>.md`.
    fn write_event_file(vault: &Path, event: &ParsedEvent) -> PathBuf {
        let abs = event_path(vault, &event.id).unwrap();
        let serialized = parsers::serialize_event(event).unwrap();
        std::fs::write(&abs, serialized).unwrap();
        abs
    }

    /// Legacy-layout helper: write a daily file carrying inline events.
    /// Used by the read-fallback tests for un-migrated vaults.
    fn write_daily_with_events(vault: &Path, date: &str, events: Vec<ParsedEvent>) -> PathBuf {
        let daily = DailyJournal {
            date: date.to_string(),
            events,
            body: String::new(),
        };
        let abs = daily::daily_path(vault, date).unwrap();
        let serialized = parsers::serialize_daily(&daily).unwrap();
        std::fs::write(&abs, serialized).unwrap();
        abs
    }

    fn sample_event(id: &str, title: &str, date: &str, recurring: RecurringRule) -> ParsedEvent {
        ParsedEvent {
            id: id.to_string(),
            title: title.to_string(),
            subtitle: None,
            date: date.to_string(),
            duration: 30,
            area: "woodshed".to_string(),
            attendees: vec![],
            recurring,
            provider: None,
            account_id: None,
            external_id: None,
            writable: None,
            rrule_original: None,
            local_metadata_overrides: Vec::new(),
            tags: vec![],
            body: String::new(),
        }
    }

    #[test]
    fn occurrence_for_none_matches_only_literal_date() {
        let event = sample_event("e_1", "x", "2026-04-25T08:00:00-04:00", RecurringRule::None);
        let on_day = NaiveDate::from_ymd_opt(2026, 4, 25).unwrap();
        let other = NaiveDate::from_ymd_opt(2026, 4, 26).unwrap();
        assert!(occurrence_for(&event, on_day).is_some());
        assert!(occurrence_for(&event, other).is_none());
    }

    #[test]
    fn occurrence_for_weekly_matches_same_weekday() {
        let event = sample_event(
            "e_1",
            "x",
            "2026-04-25T08:00:00-04:00", // a Saturday
            RecurringRule::Weekly,
        );
        for week in 0..8 {
            let target = NaiveDate::from_ymd_opt(2026, 4, 25)
                .unwrap()
                .checked_add_days(chrono::Days::new(7 * week))
                .unwrap();
            assert!(
                occurrence_for(&event, target).is_some(),
                "expected match for week +{week}"
            );
        }
        let sunday = NaiveDate::from_ymd_opt(2026, 4, 26).unwrap();
        assert!(occurrence_for(&event, sunday).is_none());
        let before = NaiveDate::from_ymd_opt(2026, 4, 18).unwrap();
        assert!(occurrence_for(&event, before).is_none());
    }

    #[test]
    fn occurrence_for_daily_matches_every_day_after_start() {
        let event = sample_event(
            "e_1",
            "x",
            "2026-04-25T08:00:00-04:00",
            RecurringRule::Daily,
        );
        for offset in 0..14 {
            let target = NaiveDate::from_ymd_opt(2026, 4, 25)
                .unwrap()
                .checked_add_days(chrono::Days::new(offset))
                .unwrap();
            assert!(occurrence_for(&event, target).is_some());
        }
    }

    #[test]
    fn occurrence_for_monthly_matches_same_day_of_month() {
        let event = sample_event(
            "e_1",
            "x",
            "2026-01-15T08:00:00-04:00",
            RecurringRule::Monthly,
        );
        for month in 1..=12 {
            let target = NaiveDate::from_ymd_opt(2026, month, 15).unwrap();
            assert!(
                occurrence_for(&event, target).is_some(),
                "expected match for 2026-{month:02}-15"
            );
        }
        let other = NaiveDate::from_ymd_opt(2026, 2, 16).unwrap();
        assert!(occurrence_for(&event, other).is_none());
    }

    #[test]
    fn occurrence_projects_time_onto_target_date() {
        let event = sample_event(
            "e_1",
            "x",
            "2026-04-25T08:30:00-04:00",
            RecurringRule::Weekly,
        );
        let next_week = NaiveDate::from_ymd_opt(2026, 5, 2).unwrap();
        let projected = occurrence_for(&event, next_week).unwrap();
        assert!(projected.starts_with("2026-05-02T08:30:00"));
    }

    #[test]
    fn rebuild_index_populates_from_events_dir() {
        let (_tmp, vault) = setup_vault();
        let e1 = sample_event(
            "e_1",
            "Standup",
            "2026-04-25T09:00:00-04:00",
            RecurringRule::Daily,
        );
        let e2 = sample_event(
            "e_2",
            "Alex 1:1",
            "2026-04-25T08:00:00-04:00",
            RecurringRule::Weekly,
        );
        write_event_file(&vault, &e1);
        write_event_file(&vault, &e2);

        let idx = EventIndex::new();
        let cache = EventsCache::new();
        rebuild_index(&vault, &idx, &cache).unwrap();
        // Each id resolves to its own file.
        assert_ne!(idx.get("e_1"), idx.get("e_2"));
        assert_eq!(idx.get("e_1").unwrap(), event_path(&vault, "e_1").unwrap());
        // Cache mirrors the index: both events are recurring so they live
        // in the recurring bucket. by_date is empty (no non-recurring rows).
        let (_, recurring) = cache.snapshot_for_date(NaiveDate::from_ymd_opt(2026, 4, 25).unwrap());
        assert_eq!(recurring.len(), 2);
    }

    #[test]
    fn rebuild_index_read_fallback_picks_up_inline_events() {
        // Un-migrated vault: no events/ files, but inline events in
        // cadence/ daily files. rebuild_index must still find them.
        let (_tmp, vault) = setup_vault();
        write_daily_with_events(
            &vault,
            "2026-04-25",
            vec![sample_event(
                "e_inline",
                "Standup",
                "2026-04-25T09:00:00-04:00",
                RecurringRule::None,
            )],
        );
        let idx = EventIndex::new();
        let cache = EventsCache::new();
        rebuild_index(&vault, &idx, &cache).unwrap();
        let p = idx.get("e_inline").unwrap();
        assert!(p.ends_with("cadence/2026-04-25.md"));
    }

    #[test]
    fn rebuild_index_events_dir_wins_over_inline_fallback() {
        // A half-migrated vault: the same id appears both as a standalone
        // event file AND inline in a daily. The standalone file is the
        // canonical home — must win.
        let (_tmp, vault) = setup_vault();
        let event = sample_event(
            "e_x",
            "Standup",
            "2026-04-25T09:00:00-04:00",
            RecurringRule::None,
        );
        write_event_file(&vault, &event);
        write_daily_with_events(
            &vault,
            "2026-04-25",
            vec![sample_event(
                "e_x",
                "Old inline title",
                "2026-04-25T09:00:00-04:00",
                RecurringRule::None,
            )],
        );

        let idx = EventIndex::new();
        let cache = EventsCache::new();
        rebuild_index(&vault, &idx, &cache).unwrap();
        let p = idx.get("e_x").unwrap();
        assert_eq!(p, event_path(&vault, "e_x").unwrap());
    }

    #[test]
    fn events_cache_filters_to_target_day() {
        let (_tmp, vault) = setup_vault();
        let e1 = sample_event(
            "e_1",
            "Standup",
            "2026-04-25T09:00:00-04:00",
            RecurringRule::None,
        );
        let e2 = sample_event(
            "e_2",
            "Other",
            "2026-04-26T09:00:00-04:00",
            RecurringRule::None,
        );
        write_event_file(&vault, &e1);
        write_event_file(&vault, &e2);
        let cache = EventsCache::new();
        let idx = EventIndex::new();
        rebuild_index(&vault, &idx, &cache).unwrap();
        let on_day = NaiveDate::from_ymd_opt(2026, 4, 25).unwrap();
        let events = collect_events_from_cache(&cache, &vault, on_day);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "e_1");
    }

    #[test]
    fn events_cache_expands_weekly() {
        let (_tmp, vault) = setup_vault();
        let e = sample_event(
            "e_weekly",
            "Alex 1:1",
            "2026-04-25T08:00:00-04:00",
            RecurringRule::Weekly,
        );
        write_event_file(&vault, &e);
        let cache = EventsCache::new();
        let idx = EventIndex::new();
        rebuild_index(&vault, &idx, &cache).unwrap();
        let later = NaiveDate::from_ymd_opt(2026, 5, 9).unwrap();
        let events = collect_events_from_cache(&cache, &vault, later);
        assert_eq!(events.len(), 1);
        assert!(events[0].date.starts_with("2026-05-09T08:00:00"));
    }

    #[test]
    fn collect_inline_events_fallback_reads_legacy_dailies() {
        // Vault without an events/ dir (un-migrated). The inline fallback
        // must still surface events on the queried date.
        let (_tmp, vault) = setup_vault();
        write_daily_with_events(
            &vault,
            "2026-04-25",
            vec![sample_event(
                "e_inline",
                "Standup",
                "2026-04-25T09:00:00-04:00",
                RecurringRule::None,
            )],
        );
        let on_day = NaiveDate::from_ymd_opt(2026, 4, 25).unwrap();
        let events = collect_inline_events_from_cadence(&vault, on_day).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "e_inline");
    }

    fn person_ref(id: &str, email: Option<&str>, area: Option<&str>) -> crate::state::PersonRef {
        crate::state::PersonRef {
            id: id.to_string(),
            name: id.to_string(),
            email: email.map(|e| e.to_ascii_lowercase()),
            area: area.map(|a| a.to_string()),
        }
    }

    #[test]
    fn infer_area_from_ical_attendee_domain() {
        // The motivating case: a meeting full of @acme.example addresses,
        // only a couple of which are individually in the People folder.
        // Both the matched people AND the bare-domain attendees should
        // resolve to the acme area.
        let idx = crate::state::PeopleEmailIndex::new();
        idx.replace(vec![
            person_ref("alex-rivera", Some("alex@acme.example"), Some("acme")),
            person_ref("sam-chen", Some("sam@acme.example"), Some("acme")),
        ]);
        let attendees = vec![
            "alex@acme.example".to_string(),
            "product@acme.example".to_string(), // not in People — domain match
            "support@acme.example".to_string(), // not in People — domain match
        ];
        assert_eq!(
            infer_area_from_attendees(&attendees, true, &idx),
            Some("acme".to_string())
        );
    }

    #[test]
    fn infer_area_ignores_generic_email_domains() {
        // A single personal contact at gmail.com must not drag every
        // gmail attendee into that contact's area.
        let idx = crate::state::PeopleEmailIndex::new();
        idx.replace(vec![person_ref(
            "a-friend",
            Some("friend@gmail.com"),
            Some("personal"),
        )]);
        // A different, unknown gmail attendee gets no area from the domain.
        let unknown = vec!["someone-else@gmail.com".to_string()];
        assert_eq!(infer_area_from_attendees(&unknown, true, &idx), None);
        // But the known individual still votes their own area.
        let known = vec!["friend@gmail.com".to_string()];
        assert_eq!(
            infer_area_from_attendees(&known, true, &idx),
            Some("personal".to_string())
        );
    }

    #[test]
    fn infer_area_picks_plurality_and_is_deterministic() {
        let idx = crate::state::PeopleEmailIndex::new();
        idx.replace(vec![
            person_ref("p1", Some("p1@acme.com"), Some("acme")),
            person_ref("p2", Some("p2@acme.com"), Some("acme")),
            person_ref("p3", Some("p3@globex.com"), Some("globex")),
        ]);
        let attendees = vec![
            "p1@acme.com".to_string(),
            "p2@acme.com".to_string(),
            "p3@globex.com".to_string(),
        ];
        // acme has two votes, globex one — acme wins.
        assert_eq!(
            infer_area_from_attendees(&attendees, true, &idx),
            Some("acme".to_string())
        );
    }

    #[test]
    fn infer_area_for_vault_local_attendees_uses_person_ids() {
        let idx = crate::state::PeopleEmailIndex::new();
        idx.replace(vec![person_ref(
            "alex-rivera",
            Some("alex@acme.com"),
            Some("acme"),
        )]);
        // Vault-local events store attendees as person ids, not emails.
        let attendees = vec!["alex-rivera".to_string()];
        assert_eq!(
            infer_area_from_attendees(&attendees, false, &idx),
            Some("acme".to_string())
        );
        // The same id treated as an email (is_external) finds nothing.
        assert_eq!(infer_area_from_attendees(&attendees, true, &idx), None);
    }

    #[test]
    fn infer_area_none_when_no_attendee_has_an_area() {
        let idx = crate::state::PeopleEmailIndex::new();
        idx.replace(vec![person_ref("nobody", Some("x@unknown.com"), None)]);
        let attendees = vec!["y@nowhere.com".to_string()];
        assert_eq!(infer_area_from_attendees(&attendees, true, &idx), None);
    }
}
