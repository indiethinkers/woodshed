// JSON-on-disk + in-memory cache for iCal events.
//
// Replaces the v1 approach of materializing every VEVENT as its own
// markdown file in `cadence/`. That worked for vault-local events
// (handful per day) but broke spectacularly for Google Calendar
// feeds containing 5000+ events: the syscall storm + watcher fan-out
// crashed the renderer mid-sync.
//
// New shape:
//   - One JSON file per calendar at
//     `<app_data_dir>/gcal-cache/<account_id>.json`
//   - One in-memory `Mutex<HashMap<account_id, Vec<IcalEvent>>>` in
//     AppState, hydrated from disk on startup, replaced on each sync
//   - The `events_for_date` Tauri command reads vault markdown files
//     (vault-local events) AND queries this cache (iCal events),
//     merging by target date
//
// The cache is always a complete replacement — every sync overwrites
// the JSON wholesale. No diffing, no orphan reconciliation. Simpler.

use crate::commands::events::{project_occurrence, EventDto};
use crate::gcal::{ical::IcalEvent, validate_account_id};
use crate::parsers::{EventProvider, RecurringRule};
use crate::sync_ext::MutexRecover;
use chrono::{Datelike, NaiveDate, TimeZone, Weekday};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const CACHE_SUBDIR: &str = "gcal-cache";
pub(crate) const MAX_CACHED_EVENTS_PER_ACCOUNT: usize = 100_000;
const MAX_CACHE_FILE_BYTES: u64 = 128 * 1024 * 1024;
const FUTURE_CACHE_FLOOR_YEAR: i32 = 2026;
const FUTURE_CACHE_FLOOR_MONTH: u32 = 1;
const FUTURE_CACHE_FLOOR_DAY: u32 = 1;

/// In-memory cache of every configured iCal calendar's most recent
/// parse. Lives in AppState; populated on startup by `load_from_disk`
/// and on every sync by `set`. Reads are O(events) per query — fine
/// for the 5000-event-per-calendar scale we care about.
pub struct IcalEventCache {
    inner: Mutex<HashMap<String, Vec<IcalEvent>>>,
}

impl IcalEventCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn set(&self, account_id: String, events: Vec<IcalEvent>) {
        self.inner.lock_recover().insert(account_id, events);
    }

    pub fn remove(&self, account_id: &str) {
        self.inner.lock_recover().remove(account_id);
    }

    /// Total event count across every cached calendar. Used by logging
    /// and tests; not surfaced to the frontend.
    pub fn len(&self) -> usize {
        self.inner.lock_recover().values().map(|v| v.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock_recover().values().all(Vec::is_empty)
    }

    /// Look up a single cached iCal event by (account_id, external_id).
    /// Used by the meeting-notes flow: the user opens an iCal event,
    /// writes notes, and we need the canonical metadata to merge into
    /// the saved notes file's frontmatter.
    pub fn find_event(&self, account_id: &str, external_id: &str) -> Option<IcalEvent> {
        let inner = self.inner.lock_recover();
        inner
            .get(account_id)
            .and_then(|events| events.iter().find(|e| e.uid == external_id).cloned())
    }

    /// Every cached iCal event, paired with its owning account_id.
    /// Used by the tag-table query (which lists all `#event` rows
    /// without projecting onto a specific day).
    pub fn all_unprojected(&self) -> Vec<(String, IcalEvent)> {
        let inner = self.inner.lock_recover();
        let mut out = Vec::new();
        for (account_id, events) in inner.iter() {
            for ev in events {
                out.push((account_id.clone(), ev.clone()));
            }
        }
        out
    }

    /// Project every cached event onto `target`. Walks each calendar,
    /// applies the recurrence rule (with overrides honored), and emits
    /// an `EventDto` for each occurrence that falls on the day. The
    /// frontend merges these with vault-local events and re-sorts by
    /// time.
    pub fn events_for_date(&self, target: NaiveDate) -> Vec<EventDto> {
        let inner = self.inner.lock_recover();
        let mut out = Vec::new();
        for (account_id, events) in inner.iter() {
            for ev in events {
                for occ in project_ical_occurrences(ev, target) {
                    out.push(ical_to_dto_with_override(account_id, ev, occ));
                }
            }
        }
        out
    }

    /// Project one cached iCal event onto `target`. Used by the detail
    /// page when a schedule row links to a specific recurrence instance.
    pub fn event_for_date(
        &self,
        account_id: &str,
        external_id: &str,
        target: NaiveDate,
    ) -> Option<EventDto> {
        let inner = self.inner.lock_recover();
        let ev = inner
            .get(account_id)?
            .iter()
            .find(|ev| ev.uid == external_id)?;
        project_ical_occurrences(ev, target)
            .into_iter()
            .next()
            .map(|occ| ical_to_dto_with_override(account_id, ev, occ))
    }
}

/// One projected occurrence of an iCal event for a given target date.
/// Carries the master's metadata by default but can carry overlays
/// from a matching `RecurrenceOverride` (single-instance edits like a
/// time shift or retitle).
struct ProjectedOccurrence {
    dtstart_rfc3339: String,
    /// `Some` ⇒ override replaces the master's duration. `None` ⇒
    /// inherit.
    duration_override: Option<u32>,
    /// `Some` ⇒ override retitled this single instance. `None` ⇒
    /// inherit.
    summary_override: Option<String>,
}

/// Project an iCal event onto `target`, returning zero or more
/// occurrences. Most events emit zero or one; the only way to get
/// multiple is when several overrides happen to relocate to the same
/// day (vanishingly rare, but handled).
///
/// Order of operations:
///   1. Honor `UNTIL`. The master can't fire past its bound, BUT
///      overrides explicitly placed past UNTIL still apply — Google
///      lets you move a "last" instance to a later date.
///   2. Emit any overrides whose *new* dtstart lands on `target`.
///   3. Emit the master's own projection on `target` if (a) the RRULE
///      matches and (b) no override pre-empted this date.
fn project_ical_occurrences(ev: &IcalEvent, target: NaiveDate) -> Vec<ProjectedOccurrence> {
    let mut out = Vec::new();
    let target_iso = target.format("%Y-%m-%d").to_string();

    // (2) Overrides that relocated to `target`. Cancellations and
    // overrides whose new dtstart is on a different day don't emit
    // here — they just exist in the override list so step (3) below
    // knows to suppress the master.
    for ov in &ev.overrides {
        if ov.cancelled {
            continue;
        }
        let Some(new_dt_str) = ov.dtstart_rfc3339.as_deref() else {
            continue;
        };
        let Some(new_dt) = parse_event_dt(new_dt_str) else {
            continue;
        };
        if new_dt.date_naive() == target {
            out.push(ProjectedOccurrence {
                dtstart_rfc3339: new_dt_str.to_string(),
                duration_override: ov.duration_minutes,
                summary_override: ov.summary.clone(),
            });
        }
    }

    // (3) Master projection — suppressed when an override claimed
    // this `target` as its original-occurrence date, or when Google
    // emitted an EXDATE for this occurrence. The override either
    // replaced this occurrence (already emitted above when same-day)
    // or moved/cancelled it.
    let preempted = ev.overrides.iter().any(|o| o.original_date == target_iso)
        || ev.exdates.iter().any(|d| d == &target_iso);
    if !preempted {
        if let Some(dt_str) = project_master(ev, target) {
            // UNTIL and COUNT apply only to the master's projection,
            // not to explicit overrides. An override past UNTIL is a
            // concrete VEVENT from Google and stays valid.
            if master_within_until(ev.rrule_until.as_deref(), &dt_str, target)
                && master_within_count(ev, target)
            {
                out.push(ProjectedOccurrence {
                    dtstart_rfc3339: dt_str,
                    duration_override: None,
                    summary_override: None,
                });
            }
        }
    }

    out
}

/// Master-only projection, honoring BYDAY (multi-day weekly) and
/// INTERVAL (every-Nth cadence) on top of the small `RecurringRule`
/// enum. Falls back to `project_occurrence` (the vault-local-event
/// projection) when neither extra modifier is present, so the simple
/// weekly/daily/monthly path stays byte-identical.
fn project_master(ev: &IcalEvent, target: NaiveDate) -> Option<String> {
    let interval = ev.rrule_interval.max(1);
    let no_extras = ev.rrule_byday.is_empty() && interval == 1;
    if no_extras {
        return project_occurrence(&ev.dtstart_rfc3339, ev.recurring_enum, target);
    }

    let dt = parse_event_dt(&ev.dtstart_rfc3339)?;
    let event_date = dt.date_naive();
    if target < event_date {
        return None;
    }
    if target == event_date {
        return Some(ev.dtstart_rfc3339.clone());
    }

    let matches = match ev.recurring_enum {
        RecurringRule::None => false,
        RecurringRule::Daily => {
            let diff = (target - event_date).num_days();
            diff >= 0 && (diff as u64) % (interval as u64) == 0
        }
        RecurringRule::Weekly => {
            // Two conditions to satisfy:
            //   (a) target weekday is in BYDAY (or, when BYDAY is
            //       empty, equals the anchor weekday).
            //   (b) the *week* target falls in is on-cycle relative
            //       to the anchor's week: weeks_between % interval == 0.
            // We compute weeks-between using each date's Monday so
            // BYDAY=TU,TH off a Tuesday anchor counts the same week
            // for both occurrences (instead of Tue→Thu wrapping to
            // the next week and falsely dropping every other Thursday
            // when INTERVAL=2).
            let weekday_ok = if ev.rrule_byday.is_empty() {
                target.weekday() == event_date.weekday()
            } else {
                let wanted = weekday_code(target.weekday());
                ev.rrule_byday.iter().any(|d| d == wanted)
            };
            if !weekday_ok {
                return None;
            }
            let target_monday = monday_of(target);
            let anchor_monday = monday_of(event_date);
            let weeks = (target_monday - anchor_monday).num_days() / 7;
            weeks >= 0 && (weeks as u64) % (interval as u64) == 0
        }
        RecurringRule::Monthly => {
            if target.day() != event_date.day() {
                return None;
            }
            let months = (target.year() as i64 - event_date.year() as i64) * 12
                + (target.month() as i64 - event_date.month() as i64);
            months >= 0 && (months as u64) % (interval as u64) == 0
        }
    };
    if !matches {
        return None;
    }
    // Anchor in chrono::Local so the wall-clock holds across DST — see
    // project_occurrence in commands/events.rs for the full rationale.
    let local_time = dt.with_timezone(&chrono::Local).time();
    let projected_naive = target.and_time(local_time);
    if let chrono::LocalResult::Single(zoned) = chrono::Local.from_local_datetime(&projected_naive)
    {
        return Some(zoned.with_timezone(dt.offset()).to_rfc3339());
    }
    let fallback = dt.offset().from_local_datetime(&projected_naive).single()?;
    Some(fallback.to_rfc3339())
}

fn master_within_until(until: Option<&str>, projected_dt: &str, target: NaiveDate) -> bool {
    let Some(until) = until else {
        return true;
    };
    if let Ok(until_dt) = chrono::DateTime::parse_from_rfc3339(until) {
        return parse_event_dt(projected_dt)
            .map(|dt| dt.with_timezone(&chrono::Utc) <= until_dt.with_timezone(&chrono::Utc))
            .unwrap_or(true);
    }
    if let Ok(until_date) = NaiveDate::parse_from_str(until, "%Y-%m-%d") {
        return target <= until_date;
    }
    true
}

fn master_within_count(ev: &IcalEvent, target: NaiveDate) -> bool {
    let Some(count) = ev.rrule_count else {
        return true;
    };
    if count == 0 {
        return false;
    }
    let Some(start_dt) = parse_event_dt(&ev.dtstart_rfc3339) else {
        return true;
    };
    let mut day = std::cmp::min(
        start_dt.date_naive(),
        start_dt.with_timezone(&chrono::Local).date_naive(),
    );
    let mut seen = 0u32;
    while day <= target {
        if project_master(ev, day).is_some() {
            seen = seen.saturating_add(1);
            if day == target {
                return seen <= count;
            }
            if seen >= count {
                return false;
            }
        }
        let Some(next) = day.checked_add_days(chrono::Days::new(1)) else {
            break;
        };
        day = next;
    }
    true
}

/// Cutoff used for the one-time cleanup of the historical iCal cache.
/// Syncs use today's local date instead; this floor exists only so old
/// cache files created by prior builds stop flooding the tag table.
pub fn historical_cache_floor_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(
        FUTURE_CACHE_FLOOR_YEAR,
        FUTURE_CACHE_FLOOR_MONTH,
        FUTURE_CACHE_FLOOR_DAY,
    )
    .expect("static iCal cache floor date is valid")
}

pub fn retain_events_on_or_after_or_note_backed(
    events: Vec<IcalEvent>,
    start: NaiveDate,
    account_id: &str,
    note_backed_series_ids: &HashSet<String>,
) -> Vec<IcalEvent> {
    events
        .into_iter()
        .filter(|ev| {
            event_occurs_on_or_after(ev, start)
                || note_backed_series_ids.contains(&synthetic_event_id(account_id, &ev.uid))
        })
        .collect()
}

pub fn note_backed_ical_series_ids(vault: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    let dir = crate::vault::events_dir(vault);
    if !crate::vault::is_real_directory(&dir) {
        return out;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !crate::vault::is_real_file(&path)
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !stem.starts_with("e_gcal_") {
            continue;
        }
        let Ok(content) = crate::vault::read_record(&path) else {
            continue;
        };
        if !frontmatter_has_ical_provider(&content) || strip_frontmatter(&content).trim().is_empty()
        {
            continue;
        }
        out.insert(ical_note_series_id(stem).to_string());
    }
    out
}

fn frontmatter_has_ical_provider(content: &str) -> bool {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return false;
    }
    let Some(open_end) = trimmed.find('\n') else {
        return false;
    };
    let after_open = &trimmed[open_end + 1..];
    let Some(close_start) = after_open.find("\n---") else {
        return false;
    };
    after_open[..close_start].lines().any(|line| {
        let line = line.trim();
        line == "provider: ical" || line == "provider: \"ical\"" || line == "provider: 'ical'"
    })
}

fn ical_note_series_id(stem: &str) -> &str {
    if stem.len() > 9 {
        let suffix_start = stem.len() - 9;
        let suffix = &stem[suffix_start..];
        if suffix.starts_with('_') && suffix[1..].chars().all(|c| c.is_ascii_digit()) {
            return &stem[..suffix_start];
        }
    }
    stem
}

/// Series-level cache filter. Google Calendar stores recurring events
/// as one master VEVENT, so an active weekly meeting can have a 2024
/// `DTSTART`. We therefore cannot drop by raw start date alone.
pub fn event_occurs_on_or_after(ev: &IcalEvent, start: NaiveDate) -> bool {
    if has_future_override(ev, start) {
        return true;
    }

    if ev.recurring_enum == RecurringRule::None {
        return event_local_date(&ev.dtstart_rfc3339)
            .map(|date| date >= start)
            .unwrap_or(true);
    }

    if recurrence_ends_before(ev, start) {
        return false;
    }

    let Some(count) = ev.rrule_count else {
        return true;
    };
    if count == 0 {
        return false;
    }
    generated_master_occurrences_before(ev, start, count) < count
}

fn has_future_override(ev: &IcalEvent, start: NaiveDate) -> bool {
    ev.overrides.iter().any(|ov| {
        if ov.cancelled {
            return false;
        }
        ov.dtstart_rfc3339
            .as_deref()
            .and_then(event_local_date)
            .map(|date| date >= start)
            .unwrap_or(false)
    })
}

fn event_local_date(dt: &str) -> Option<NaiveDate> {
    parse_event_dt(dt).map(|dt| dt.with_timezone(&chrono::Local).date_naive())
}

fn recurrence_ends_before(ev: &IcalEvent, start: NaiveDate) -> bool {
    let Some(until) = ev.rrule_until.as_deref() else {
        return false;
    };
    let until_date = if let Ok(until_dt) = chrono::DateTime::parse_from_rfc3339(until) {
        Some(until_dt.with_timezone(&chrono::Local).date_naive())
    } else {
        NaiveDate::parse_from_str(until, "%Y-%m-%d").ok()
    };
    until_date.map(|date| date < start).unwrap_or(false)
}

fn generated_master_occurrences_before(ev: &IcalEvent, start: NaiveDate, limit: u32) -> u32 {
    let Some(start_dt) = parse_event_dt(&ev.dtstart_rfc3339) else {
        return 0;
    };
    let mut day = std::cmp::min(
        start_dt.date_naive(),
        start_dt.with_timezone(&chrono::Local).date_naive(),
    );
    let mut seen = 0u32;
    while day < start {
        if let Some(projected) = project_master(ev, day) {
            if master_within_until(ev.rrule_until.as_deref(), &projected, day) {
                seen = seen.saturating_add(1);
                if seen >= limit {
                    return seen;
                }
            }
        }
        let Some(next) = day.checked_add_days(chrono::Days::new(1)) else {
            break;
        };
        day = next;
    }
    seen
}

fn ical_to_dto_with_override(
    account_id: &str,
    ev: &IcalEvent,
    occ: ProjectedOccurrence,
) -> EventDto {
    let mut dto = ical_to_dto(account_id, ev, occ.dtstart_rfc3339);
    if let Some(d) = occ.duration_override {
        dto.duration = d;
    }
    if let Some(s) = occ.summary_override {
        dto.title = s;
    }
    dto
}

fn parse_event_dt(s: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(s).ok()
}

fn weekday_code(w: Weekday) -> &'static str {
    match w {
        Weekday::Mon => "MO",
        Weekday::Tue => "TU",
        Weekday::Wed => "WE",
        Weekday::Thu => "TH",
        Weekday::Fri => "FR",
        Weekday::Sat => "SA",
        Weekday::Sun => "SU",
    }
}

fn monday_of(date: NaiveDate) -> NaiveDate {
    let days_from_monday = date.weekday().num_days_from_monday() as i64;
    date - chrono::Duration::days(days_from_monday)
}

impl Default for IcalEventCache {
    fn default() -> Self {
        Self::new()
    }
}

fn ical_to_dto(account_id: &str, ev: &IcalEvent, projected_date: String) -> EventDto {
    let description = crate::gcal::clean::clean_description(&ev.description);
    let meeting_url =
        crate::gcal::clean::extract_meeting_url(&ev.description, ev.location.as_deref());
    EventDto {
        id: synthetic_occurrence_event_id(account_id, &ev.uid, &projected_date),
        // Virtual path: communicates "this came from a cache, not a
        // markdown file." Useful for debug; the frontend never uses it.
        path: format!("gcal-cache/{account_id}.json"),
        title: if ev.summary.is_empty() {
            "(no title)".to_string()
        } else {
            ev.summary.clone()
        },
        subtitle: ev.location.clone(),
        date: projected_date,
        duration: ev.duration_minutes,
        area: String::new(),
        // Frontend EventDto carries email-only attendee strings; the
        // PARTSTAT lives on IcalEvent for the sync filter.
        attendees: ev.attendees.iter().map(|a| a.email.clone()).collect(),
        // Populated by the top-level events_for_date / event_ical_get
        // command via `enrich_resolved_attendees` once it has access
        // to the people-email index. Empty here keeps the cache layer
        // free of AppState dependencies.
        resolved_attendees: Vec::new(),
        recurring: ev.recurring_enum,
        provider: Some(EventProvider::Ical),
        account_id: Some(account_id.to_string()),
        external_id: Some(ev.uid.clone()),
        writable: Some(false),
        rrule_original: ev.rrule_original.clone(),
        // iCal-projected events surface no user tags. The tag-table
        // query for `#event` reads `type: event` directly, so iCal-
        // cached records (which never get a file written) still
        // participate via the events_for_date merge.
        tags: Vec::new(),
        description: if description.is_empty() {
            None
        } else {
            Some(description)
        },
        meeting_url,
        // `local_overrides` is set by the caller for the cadence
        // events_for_date merge — this helper builds the projection
        // straight from the cache and doesn't see the overlay.
        local_overrides: None,
        // Body is the user's meeting NOTES — starts empty and gets
        // overlaid from `events/<occurrence_id>.md` when present. The
        // iCal `DESCRIPTION` value lives in the `description` field
        // above, separately, because conflating them led to the
        // Tiptap editor opening pre-populated with leaked HTML from
        // Google Calendar.
        body: String::new(),
    }
}

/// Synthetic Woodshed-side event id. Kept stable across syncs so
/// backlinks/search can resolve a particular iCal event to itself.
pub fn synthetic_event_id(account_id: &str, uid: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    hasher.update(b":");
    hasher.update(uid.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(20);
    out.push_str("e_gcal_");
    for byte in digest.iter().take(6) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Synthetic Woodshed-side id for one concrete iCal occurrence. The
/// series UID alone is not enough for local notes: a weekly 1:1 needs
/// distinct markdown files for May 11 and May 18 so notes don't bleed
/// forward. The date suffix keeps the id stable if the user locally
/// edits the time-of-day for that occurrence.
pub fn synthetic_occurrence_event_id(account_id: &str, uid: &str, occurrence_date: &str) -> String {
    let date = occurrence_date.trim();
    let date = if date.len() >= 10 { &date[..10] } else { date };
    let compact: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
    if compact.len() == 8 {
        format!("{}_{}", synthetic_event_id(account_id, uid), compact)
    } else {
        synthetic_event_id(account_id, uid)
    }
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    Ok(dir.join(CACHE_SUBDIR))
}

/// Persist one calendar's parsed events to disk. Atomic via temp+rename
/// so a crash mid-write never leaves a half-readable JSON file.
pub fn save_to_disk(app: &AppHandle, account_id: &str, events: &[IcalEvent]) -> Result<(), String> {
    validate_account_id(account_id)?;
    if events.len() > MAX_CACHED_EVENTS_PER_ACCOUNT {
        return Err(format!(
            "calendar has too many events to cache (maximum {MAX_CACHED_EVENTS_PER_ACCOUNT})"
        ));
    }
    let dir = cache_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{account_id}.json"));
    let json = serde_json::to_vec(events).map_err(|e| e.to_string())?;
    if json.len() as u64 > MAX_CACHE_FILE_BYTES {
        return Err("serialized calendar cache exceeds 128 MiB".to_string());
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_from_disk(app: &AppHandle, account_id: &str) -> Result<(), String> {
    validate_account_id(account_id)?;
    let path = cache_dir(app)?.join(format!("{account_id}.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hydrate the in-memory cache from disk on startup. Idempotent —
/// safe to call multiple times. Returns the number of calendars
/// loaded so callers can log it.
pub fn load_from_disk(
    app: &AppHandle,
    cache: &IcalEventCache,
    vault: Option<&Path>,
) -> Result<usize, String> {
    let dir = match cache_dir(app) {
        Ok(d) => d,
        Err(_) => return Ok(0),
    };
    if !crate::vault::is_real_directory(&dir) {
        return Ok(0);
    }
    let note_backed_series_ids = vault.map(note_backed_ical_series_ids).unwrap_or_default();
    let mut loaded = 0;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if validate_account_id(&id).is_err() {
            crate::log_warn!("gcal::cache", "ignored cache with invalid account id");
            continue;
        }
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_CACHE_FILE_BYTES => meta,
            _ => {
                crate::log_warn!("gcal::cache", "ignored oversized or non-file cache {id}");
                continue;
            }
        };
        debug_assert!(metadata.len() <= MAX_CACHE_FILE_BYTES);
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        match serde_json::from_slice::<Vec<IcalEvent>>(&bytes) {
            Ok(events) if events.len() <= MAX_CACHED_EVENTS_PER_ACCOUNT => {
                let original_len = events.len();
                let events = retain_events_on_or_after_or_note_backed(
                    events,
                    historical_cache_floor_date(),
                    &id,
                    &note_backed_series_ids,
                );
                if events.len() != original_len {
                    if let Err(e) = save_to_disk(app, &id, &events) {
                        crate::log_warn!(
                            "gcal::cache",
                            "failed to prune historical cache {id}: {e}"
                        );
                    }
                }
                cache.set(id, events);
                loaded += 1;
            }
            Ok(_) => {
                crate::log_warn!("gcal::cache", "ignored cache with too many events {id}");
            }
            Err(e) => {
                crate::log_warn!("gcal::cache", "failed to parse iCal cache {id}: {e}");
            }
        }
    }
    Ok(loaded)
}

/// One-shot cleanup of leftover `cadence/gcal-*.md` files written by
/// the pre-cache implementation (5000+ files per calendar). Idempotent:
/// after the first run on a fresh vault, this finds nothing and exits
/// in milliseconds. Called from `watcher_start` after the index
/// rebuild so the search index doesn't keep stale entries.
pub fn cleanup_legacy_cadence_files(vault: &std::path::Path) -> Result<u32, String> {
    let cadence = crate::vault::cadence_dir(vault);
    if !crate::vault::is_real_directory(&cadence) {
        return Ok(0);
    }
    let mut deleted = 0;
    for entry in std::fs::read_dir(&cadence).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !crate::vault::is_real_file(&path) {
            continue;
        }
        let filename = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => continue,
        };
        if !filename.starts_with("gcal-") || !filename.ends_with(".md") {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// One-shot cleanup of leftover per-event files at `events/g_*.md`
/// written by the pre-cache implementation (one file per gcal event,
/// keyed by `g_<calendar>_<id>_<datetime>Z`). These files predate
/// `provider: ical` and the synthetic-id overlay model — without the
/// flag they look like vault-local events to the read merge, so the
/// same meeting surfaces twice on the cadence page (once from the
/// iCal cache, once from this orphan).
///
/// Safe deletion: only files whose body matches the auto-generated
/// "Synced from Google Calendar (…). Event: …" placeholder are
/// removed. Files where the user wrote real meeting notes are spared,
/// regardless of filename — protecting against false positives if a
/// user happened to name a real note with the legacy prefix.
///
/// Idempotent: re-running on a swept vault finds nothing and exits in
/// milliseconds.
pub fn cleanup_legacy_per_event_files(vault: &std::path::Path) -> Result<u32, String> {
    let events_dir = crate::vault::events_dir(vault);
    if !crate::vault::is_real_directory(&events_dir) {
        return Ok(0);
    }
    let mut deleted = 0;
    for entry in std::fs::read_dir(&events_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !crate::vault::is_real_file(&path) {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => continue,
        };
        let ext = path.extension().and_then(|s| s.to_str());
        if ext != Some("md") || !is_legacy_per_event_id(stem) {
            continue;
        }
        let content = match crate::vault::read_record(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !is_auto_generated_placeholder_body(&content) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// Match the legacy ID format `g_<calendar>_<id>_<YYYYMMDD>T<HHMMSS>Z`.
/// The trailing date-time segment is the distinctive part — current
/// `synthetic_event_id` outputs `e_gcal_<12 hex chars>` and never has
/// that shape.
fn is_legacy_per_event_id(stem: &str) -> bool {
    if !stem.starts_with("g_") {
        return false;
    }
    let Some((_, last)) = stem.rsplit_once('_') else {
        return false;
    };
    // 16 chars: YYYYMMDDTHHMMSSZ
    if last.len() != 16 || !last.ends_with('Z') {
        return false;
    }
    let date = &last[..8];
    let t = &last[8..9];
    let time = &last[9..15];
    date.chars().all(|c| c.is_ascii_digit()) && t == "T" && time.chars().all(|c| c.is_ascii_digit())
}

/// Is the markdown body the auto-generated placeholder the pre-cache
/// writer emitted? Accepts any of: empty body, just whitespace, or a
/// `Synced from Google Calendar (...)\nEvent: ...` two-line stub
/// (possibly with surrounding whitespace). Returns false for anything
/// else — meaning the user wrote real content.
fn is_auto_generated_placeholder_body(content: &str) -> bool {
    // Strip YAML frontmatter.
    let body = strip_frontmatter(content).trim();
    if body.is_empty() {
        return true;
    }
    let mut saw_synced = false;
    let mut saw_event = false;
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("Synced from Google Calendar") {
            saw_synced = true;
            continue;
        }
        if line.starts_with("Event:") {
            saw_event = true;
            continue;
        }
        // Any other non-empty line ⇒ user wrote real content.
        return false;
    }
    saw_synced && saw_event
}

fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return content;
    }
    // Find the closing `---` line.
    let after_open = match trimmed.find('\n') {
        Some(i) => &trimmed[i + 1..],
        None => return "",
    };
    if let Some(end) = after_open.find("\n---") {
        let rest = &after_open[end + 4..];
        return rest.trim_start_matches('\r').trim_start_matches('\n');
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parsers::RecurringRule;
    use chrono::NaiveDate;
    use tempfile::TempDir;

    fn sample_ical(uid: &str, dtstart: &str, recurring: RecurringRule) -> IcalEvent {
        IcalEvent {
            uid: uid.to_string(),
            summary: "Standup".to_string(),
            description: String::new(),
            dtstart_rfc3339: dtstart.to_string(),
            duration_minutes: 30,
            recurring_enum: recurring,
            rrule_original: None,
            rrule_until: None,
            rrule_count: None,
            rrule_byday: vec![],
            rrule_interval: 1,
            exdates: vec![],
            location: None,
            attendees: vec![],
            organizer_email: None,
            overrides: vec![],
        }
    }

    fn emails(addrs: &[&str]) -> Vec<String> {
        addrs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn user_declined_detects_declined_partstat() {
        use crate::gcal::ical::Attendee;
        let mut ev = sample_ical("e", "2026-05-11T08:00:00+00:00", RecurringRule::None);
        ev.attendees = vec![
            Attendee {
                email: "me@example.com".to_string(),
                partstat: Some("DECLINED".to_string()),
            },
            Attendee {
                email: "boss@example.com".to_string(),
                partstat: Some("ACCEPTED".to_string()),
            },
        ];
        assert!(ev.user_declined(&emails(&["me@example.com"])));
        // Case-insensitive matching on email.
        assert!(ev.user_declined(&emails(&["ME@EXAMPLE.COM"])));
        // Empty email list = no filter (no addresses configured).
        assert!(!ev.user_declined(&[]));
        // Different user, not declined.
        assert!(!ev.user_declined(&emails(&["boss@example.com"])));
    }

    #[test]
    fn user_declined_matches_any_of_user_emails() {
        // Multiple addresses per calendar — work + personal — and
        // the user has declined under one of them.
        use crate::gcal::ical::Attendee;
        let mut ev = sample_ical("e", "2026-05-11T08:00:00+00:00", RecurringRule::None);
        ev.attendees = vec![Attendee {
            email: "owner@work.example".to_string(),
            partstat: Some("DECLINED".to_string()),
        }];
        assert!(ev.user_declined(&emails(&["owner@personal.example", "owner@work.example",])));
    }

    #[test]
    fn user_declined_returns_false_when_user_only_accepted() {
        use crate::gcal::ical::Attendee;
        let mut ev = sample_ical("e", "2026-05-11T08:00:00+00:00", RecurringRule::None);
        ev.attendees = vec![Attendee {
            email: "me@example.com".to_string(),
            partstat: Some("ACCEPTED".to_string()),
        }];
        assert!(!ev.user_declined(&emails(&["me@example.com"])));
    }

    #[test]
    fn user_involved_keeps_organizer_events() {
        let mut ev = sample_ical("e", "2026-05-11T08:00:00+00:00", RecurringRule::None);
        ev.organizer_email = Some("me@example.com".to_string());
        ev.attendees = vec![];
        assert!(ev.user_involved(&emails(&["me@example.com"])));
    }

    #[test]
    fn user_involved_keeps_attendee_events() {
        use crate::gcal::ical::Attendee;
        let mut ev = sample_ical("e", "2026-05-11T08:00:00+00:00", RecurringRule::None);
        ev.organizer_email = Some("boss@example.com".to_string());
        ev.attendees = vec![Attendee {
            email: "me@example.com".to_string(),
            partstat: Some("ACCEPTED".to_string()),
        }];
        assert!(ev.user_involved(&emails(&["me@example.com"])));
    }

    #[test]
    fn user_involved_matches_any_of_user_emails() {
        // Workspace meeting where the user is invited as
        // their work alias, but their Woodshed profile lists both
        // personal Gmail and the work alias.
        use crate::gcal::ical::Attendee;
        let mut ev = sample_ical("e", "2026-05-11T08:00:00+00:00", RecurringRule::None);
        ev.organizer_email = Some("teammate@work.example".to_string());
        ev.attendees = vec![Attendee {
            email: "owner@work.example".to_string(),
            partstat: Some("ACCEPTED".to_string()),
        }];
        assert!(ev.user_involved(&emails(&["owner@personal.example", "owner@work.example",])));
    }

    #[test]
    fn user_involved_drops_unrelated_events() {
        use crate::gcal::ical::Attendee;
        let mut ev = sample_ical("e", "2026-05-11T08:00:00+00:00", RecurringRule::None);
        ev.organizer_email = Some("boss@example.com".to_string());
        ev.attendees = vec![Attendee {
            email: "someone-else@example.com".to_string(),
            partstat: Some("ACCEPTED".to_string()),
        }];
        assert!(!ev.user_involved(&emails(&["me@example.com"])));
    }

    #[test]
    fn user_involved_no_filter_when_emails_empty() {
        // No emails configured ⇒ filter disabled, every event kept.
        let ev = sample_ical("e", "2026-05-11T08:00:00+00:00", RecurringRule::None);
        assert!(ev.user_involved(&[]));
    }

    fn sample_ical_with_until(
        uid: &str,
        dtstart: &str,
        recurring: RecurringRule,
        until_date: &str,
    ) -> IcalEvent {
        IcalEvent {
            rrule_until: Some(until_date.to_string()),
            ..sample_ical(uid, dtstart, recurring)
        }
    }

    #[test]
    fn synthetic_event_id_is_stable_across_calls() {
        let a = synthetic_event_id("gcal_01HW", "uid@google.com");
        let b = synthetic_event_id("gcal_01HW", "uid@google.com");
        assert_eq!(a, b);
        assert!(a.starts_with("e_gcal_"));
    }

    #[test]
    fn synthetic_event_id_differs_by_account() {
        // Same UID, different account: two calendars sharing an event
        // should each surface it under their own row in the schedule.
        let a = synthetic_event_id("gcal_A", "shared@google.com");
        let b = synthetic_event_id("gcal_B", "shared@google.com");
        assert_ne!(a, b);
    }

    #[test]
    fn synthetic_occurrence_event_id_differs_by_date() {
        let a = synthetic_occurrence_event_id("gcal_A", "weekly@google.com", "2026-05-11");
        let b = synthetic_occurrence_event_id(
            "gcal_A",
            "weekly@google.com",
            "2026-05-18T15:30:00+00:00",
        );
        assert_ne!(a, b);
        assert!(a.ends_with("_20260511"));
        assert!(b.ends_with("_20260518"));
    }

    #[test]
    fn events_for_date_filters_to_target_day() {
        let cache = IcalEventCache::new();
        cache.set(
            "gcal_A".to_string(),
            vec![
                sample_ical("a", "2026-05-11T08:30:00+00:00", RecurringRule::None),
                sample_ical("b", "2026-05-12T09:00:00+00:00", RecurringRule::None),
            ],
        );
        let target = NaiveDate::from_ymd_opt(2026, 5, 11).unwrap();
        let got = cache.events_for_date(target);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].external_id.as_deref(), Some("a"));
        // Read-only flag must come through so the UI hides edit affordances.
        assert_eq!(got[0].writable, Some(false));
    }

    #[test]
    fn events_for_date_expands_weekly_recurring() {
        let cache = IcalEventCache::new();
        // Anchor on Monday 2026-05-11.
        cache.set(
            "gcal_A".to_string(),
            vec![sample_ical(
                "weekly",
                "2026-05-11T09:00:00+00:00",
                RecurringRule::Weekly,
            )],
        );
        // Following Monday → still appears.
        let next_monday = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
        assert_eq!(cache.events_for_date(next_monday).len(), 1);
        // Tuesday → does not appear.
        let tuesday = NaiveDate::from_ymd_opt(2026, 5, 12).unwrap();
        assert!(cache.events_for_date(tuesday).is_empty());
    }

    #[test]
    fn event_for_date_returns_projected_recurring_instance() {
        let cache = IcalEventCache::new();
        cache.set(
            "gcal_A".to_string(),
            vec![sample_ical(
                "weekly",
                "2026-05-11T15:30:00+00:00",
                RecurringRule::Weekly,
            )],
        );

        let target = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
        let got = cache
            .event_for_date("gcal_A", "weekly", target)
            .expect("weekly occurrence should project");

        assert_eq!(got.external_id.as_deref(), Some("weekly"));
        assert!(got.date.starts_with("2026-05-18T"));
    }

    fn sample_ical_with_byday(uid: &str, dtstart: &str, byday: &[&str]) -> IcalEvent {
        IcalEvent {
            rrule_byday: byday.iter().map(|s| s.to_string()).collect(),
            ..sample_ical(uid, dtstart, RecurringRule::Weekly)
        }
    }

    #[test]
    fn events_for_date_projects_multi_day_byday() {
        // Synthetic regression shape: "Project Standup" — anchored
        // on a Tuesday with BYDAY=TU,TH so both Tuesday and Thursday
        // should project. Before the BYDAY fix, only Tuesday fired.
        let cache = IcalEventCache::new();
        let tuesday_anchor = "2026-05-12T15:45:00+00:00";
        cache.set(
            "gcal_A".to_string(),
            vec![sample_ical_with_byday(
                "strike",
                tuesday_anchor,
                &["TU", "TH"],
            )],
        );
        // Same week's Thursday — must project.
        let thursday = NaiveDate::from_ymd_opt(2026, 5, 14).unwrap();
        let got = cache.events_for_date(thursday);
        assert_eq!(got.len(), 1, "Thursday occurrence should project");
        // Following week's Tuesday — must project.
        let next_tuesday = NaiveDate::from_ymd_opt(2026, 5, 19).unwrap();
        assert_eq!(cache.events_for_date(next_tuesday).len(), 1);
        // A non-matching weekday (Wednesday) must not.
        let wednesday = NaiveDate::from_ymd_opt(2026, 5, 13).unwrap();
        assert!(cache.events_for_date(wednesday).is_empty());
    }

    #[test]
    fn events_for_date_projects_biweekly_interval() {
        // Synthetic regression shape: "Sprint Planning" — bi-weekly on
        // Thursdays anchored 2025-08-07. Before the INTERVAL fix,
        // the parser dropped INTERVAL=2 to None so the event fired
        // only on its anchor date.
        let cache = IcalEventCache::new();
        let mut ev = sample_ical_with_byday("sprint", "2025-08-07T17:30:00+00:00", &["TH"]);
        ev.rrule_interval = 2;
        cache.set("gcal_A".to_string(), vec![ev]);

        // 2026-05-14 is 280 days (40 weeks) after 2025-08-07 — an
        // "on" week for INTERVAL=2 → must project.
        let on_week = NaiveDate::from_ymd_opt(2026, 5, 14).unwrap();
        assert_eq!(
            cache.events_for_date(on_week).len(),
            1,
            "May 14 2026 should project (even-week bi-weekly)",
        );
        // The Thursday one week later is 287 days = 41 weeks — odd
        // bi-weekly week → must NOT project.
        let off_week = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        assert!(
            cache.events_for_date(off_week).is_empty(),
            "May 21 2026 should be skipped (odd-week bi-weekly)",
        );
        // Two weeks later than the on-week — back on.
        let next_on = NaiveDate::from_ymd_opt(2026, 5, 28).unwrap();
        assert_eq!(cache.events_for_date(next_on).len(), 1);
    }

    #[test]
    fn events_for_date_byday_plus_interval_skips_off_weeks() {
        // BYDAY=TU,TH + INTERVAL=2 anchored on a Tuesday: the same
        // bi-weekly cadence should produce both Tue + Thu on "on"
        // weeks and neither on "off" weeks. The weeks-between math
        // must align on each calendar week (Monday-based), not on
        // days-since-anchor, so the Thursday in the anchor week
        // counts as the same week as the anchor Tuesday.
        let cache = IcalEventCache::new();
        let mut ev =
            sample_ical_with_byday("biweek-2day", "2026-05-12T09:00:00+00:00", &["TU", "TH"]);
        ev.rrule_interval = 2;
        cache.set("gcal_A".to_string(), vec![ev]);
        // Anchor week Thursday — same week as the Tuesday anchor.
        let same_week_thu = NaiveDate::from_ymd_opt(2026, 5, 14).unwrap();
        assert_eq!(cache.events_for_date(same_week_thu).len(), 1);
        // One week later (off-week) Tuesday — must not.
        let off_week_tue = NaiveDate::from_ymd_opt(2026, 5, 19).unwrap();
        assert!(cache.events_for_date(off_week_tue).is_empty());
        // Two weeks later (on-week) Tuesday — back on.
        let on_week_tue = NaiveDate::from_ymd_opt(2026, 5, 26).unwrap();
        assert_eq!(cache.events_for_date(on_week_tue).len(), 1);
    }

    #[test]
    fn events_for_date_applies_same_day_time_shift_override() {
        // Synthetic regression shape: weekly Thursday meeting at 10:30, user
        // drags THIS Thursday's instance to 10:00. The override
        // keeps original_date = the Thursday and points dtstart at
        // the new time, same day. Projection should emit the
        // override's 10:00, not the master's 10:30.
        use crate::gcal::ical::RecurrenceOverride;
        let mut ev = sample_ical(
            "weekly-thu",
            "2026-04-16T17:30:00+00:00",
            RecurringRule::Weekly,
        );
        ev.summary = "Alex / Morgan".to_string();
        ev.overrides = vec![RecurrenceOverride {
            original_date: "2026-05-14".to_string(),
            dtstart_rfc3339: Some("2026-05-14T17:00:00+00:00".to_string()),
            duration_minutes: Some(30),
            summary: None,
            cancelled: false,
        }];
        let cache = IcalEventCache::new();
        cache.set("gcal_A".to_string(), vec![ev]);

        let target = NaiveDate::from_ymd_opt(2026, 5, 14).unwrap();
        let got = cache.events_for_date(target);
        assert_eq!(got.len(), 1, "exactly one occurrence on overridden day");
        assert_eq!(got[0].date, "2026-05-14T17:00:00+00:00");
        assert_eq!(got[0].duration, 30);
        // A different Thursday (not overridden) still projects the
        // master's 17:30.
        let other = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        let got = cache.events_for_date(other);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].date, "2026-05-21T17:30:00+00:00");
    }

    #[test]
    fn events_for_date_applies_cross_day_move_override() {
        // Single-instance move: Thursday May 14 moved to Friday May
        // 15. The Thursday must show nothing; the Friday must show
        // the override.
        use crate::gcal::ical::RecurrenceOverride;
        let mut ev = sample_ical(
            "weekly-thu",
            "2026-04-16T17:30:00+00:00",
            RecurringRule::Weekly,
        );
        ev.overrides = vec![RecurrenceOverride {
            original_date: "2026-05-14".to_string(),
            dtstart_rfc3339: Some("2026-05-15T16:00:00+00:00".to_string()),
            duration_minutes: None,
            summary: None,
            cancelled: false,
        }];
        let cache = IcalEventCache::new();
        cache.set("gcal_A".to_string(), vec![ev]);

        // Original Thursday: nothing (master suppressed by override).
        let thu = NaiveDate::from_ymd_opt(2026, 5, 14).unwrap();
        assert!(cache.events_for_date(thu).is_empty());
        // New Friday: the override emits.
        let fri = NaiveDate::from_ymd_opt(2026, 5, 15).unwrap();
        let got = cache.events_for_date(fri);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].date, "2026-05-15T16:00:00+00:00");
    }

    #[test]
    fn events_for_date_applies_cancellation_override() {
        // Single-instance cancellation: master keeps firing on every
        // other Thursday, but the cancelled occurrence disappears.
        use crate::gcal::ical::RecurrenceOverride;
        let mut ev = sample_ical(
            "weekly-thu",
            "2026-04-16T17:30:00+00:00",
            RecurringRule::Weekly,
        );
        ev.overrides = vec![RecurrenceOverride {
            original_date: "2026-05-14".to_string(),
            dtstart_rfc3339: None,
            duration_minutes: None,
            summary: None,
            cancelled: true,
        }];
        let cache = IcalEventCache::new();
        cache.set("gcal_A".to_string(), vec![ev]);

        // Cancelled Thursday: nothing.
        let cancelled = NaiveDate::from_ymd_opt(2026, 5, 14).unwrap();
        assert!(cache.events_for_date(cancelled).is_empty());
        // Following Thursday: master still projects.
        let next = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        assert_eq!(cache.events_for_date(next).len(), 1);
    }

    #[test]
    fn events_for_date_summary_override_replaces_title() {
        // Per-instance retitle: master is "Standup", this Thursday's
        // instance was renamed to "Standup — guest speaker".
        use crate::gcal::ical::RecurrenceOverride;
        let mut ev = sample_ical(
            "weekly-thu",
            "2026-04-16T17:30:00+00:00",
            RecurringRule::Weekly,
        );
        ev.summary = "Standup".to_string();
        ev.overrides = vec![RecurrenceOverride {
            original_date: "2026-05-14".to_string(),
            dtstart_rfc3339: Some("2026-05-14T17:30:00+00:00".to_string()),
            duration_minutes: None,
            summary: Some("Standup — guest speaker".to_string()),
            cancelled: false,
        }];
        let cache = IcalEventCache::new();
        cache.set("gcal_A".to_string(), vec![ev]);

        let target = NaiveDate::from_ymd_opt(2026, 5, 14).unwrap();
        let got = cache.events_for_date(target);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, "Standup — guest speaker");
        // Untouched week: original title.
        let other = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        let got = cache.events_for_date(other);
        assert_eq!(got[0].title, "Standup");
    }

    #[test]
    fn events_for_date_honors_until_bound() {
        let cache = IcalEventCache::new();
        // Weekly event that ended on 2026-05-18.
        cache.set(
            "gcal_A".to_string(),
            vec![sample_ical_with_until(
                "old-standup",
                "2026-04-06T09:00:00+00:00",
                RecurringRule::Weekly,
                "2026-05-18",
            )],
        );
        // Within the recurrence window: should project.
        let in_range = NaiveDate::from_ymd_opt(2026, 5, 11).unwrap();
        assert_eq!(cache.events_for_date(in_range).len(), 1);
        // Exactly on the UNTIL boundary: include (the spec says UNTIL
        // is inclusive of the date).
        let on_until = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
        assert_eq!(cache.events_for_date(on_until).len(), 1);
        // After UNTIL: must not project. This is the ghost-projection
        // bug — a meeting that ended in 2024 was firing onto every
        // future Monday before this filter was added.
        let after_until = NaiveDate::from_ymd_opt(2026, 5, 25).unwrap();
        assert!(cache.events_for_date(after_until).is_empty());
    }

    #[test]
    fn events_for_date_honors_until_instant_on_same_day() {
        let cache = IcalEventCache::new();
        let mut ev = sample_ical("mugge", "2026-03-06T16:30:00+00:00", RecurringRule::Weekly);
        // Google emits this when a Friday 08:30 Pacific series was
        // ended before the 2026-05-22 occurrence. Date-only comparison
        // incorrectly kept the May 22 row alive.
        ev.rrule_until = Some("2026-05-22T06:59:59+00:00".to_string());
        cache.set("gcal_A".to_string(), vec![ev]);

        let prior_friday = NaiveDate::from_ymd_opt(2026, 5, 15).unwrap();
        assert_eq!(cache.events_for_date(prior_friday).len(), 1);
        let cutoff_day = NaiveDate::from_ymd_opt(2026, 5, 22).unwrap();
        assert!(cache.events_for_date(cutoff_day).is_empty());
    }

    #[test]
    fn events_for_date_honors_count_bound() {
        let cache = IcalEventCache::new();
        let mut ev = sample_ical(
            "single-count",
            "2022-08-12T17:00:00+00:00",
            RecurringRule::Weekly,
        );
        ev.rrule_count = Some(1);
        cache.set("gcal_A".to_string(), vec![ev]);

        let first = NaiveDate::from_ymd_opt(2022, 8, 12).unwrap();
        assert_eq!(cache.events_for_date(first).len(), 1);
        let future = NaiveDate::from_ymd_opt(2026, 5, 22).unwrap();
        assert!(cache.events_for_date(future).is_empty());
    }

    #[test]
    fn retain_events_on_or_after_drops_single_past_event() {
        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let kept = retain_events_on_or_after_or_note_backed(
            vec![
                sample_ical("past", "2025-12-31T17:00:00+00:00", RecurringRule::None),
                sample_ical("future", "2026-01-01T17:00:00+00:00", RecurringRule::None),
            ],
            start,
            "gcal_A",
            &HashSet::new(),
        );

        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].uid, "future");
    }

    #[test]
    fn retain_events_on_or_after_keeps_active_old_starting_recurring_series() {
        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let kept = retain_events_on_or_after_or_note_backed(
            vec![sample_ical(
                "weekly",
                "2025-01-06T17:00:00+00:00",
                RecurringRule::Weekly,
            )],
            start,
            "gcal_A",
            &HashSet::new(),
        );

        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].uid, "weekly");
    }

    #[test]
    fn retain_events_on_or_after_drops_recurring_series_ended_before_start() {
        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let kept = retain_events_on_or_after_or_note_backed(
            vec![sample_ical_with_until(
                "ended",
                "2025-01-06T17:00:00+00:00",
                RecurringRule::Weekly,
                "2025-12-31",
            )],
            start,
            "gcal_A",
            &HashSet::new(),
        );

        assert!(kept.is_empty());
    }

    #[test]
    fn retain_events_on_or_after_drops_count_series_exhausted_before_start() {
        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let mut ev = sample_ical(
            "single-count",
            "2025-01-06T17:00:00+00:00",
            RecurringRule::Weekly,
        );
        ev.rrule_count = Some(1);

        assert!(retain_events_on_or_after_or_note_backed(
            vec![ev],
            start,
            "gcal_A",
            &HashSet::new(),
        )
        .is_empty());
    }

    #[test]
    fn retain_events_on_or_after_keeps_note_backed_past_event() {
        let start = NaiveDate::from_ymd_opt(2026, 6, 8).unwrap();
        let account_id = "gcal_A";
        let uid = "note-backed";
        let mut note_backed = HashSet::new();
        note_backed.insert(synthetic_event_id(account_id, uid));

        let kept = retain_events_on_or_after_or_note_backed(
            vec![sample_ical(
                uid,
                "2026-06-04T17:00:00+00:00",
                RecurringRule::None,
            )],
            start,
            account_id,
            &note_backed,
        );

        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].uid, uid);
    }

    #[test]
    fn retain_events_on_or_after_keeps_future_override_after_ended_master() {
        use crate::gcal::ical::RecurrenceOverride;

        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let mut ev = sample_ical_with_until(
            "ended-with-move",
            "2025-01-06T17:00:00+00:00",
            RecurringRule::Weekly,
            "2025-12-31",
        );
        ev.overrides = vec![RecurrenceOverride {
            original_date: "2025-12-29".to_string(),
            dtstart_rfc3339: Some("2026-01-02T17:00:00+00:00".to_string()),
            duration_minutes: None,
            summary: None,
            cancelled: false,
        }];

        let kept =
            retain_events_on_or_after_or_note_backed(vec![ev], start, "gcal_A", &HashSet::new());
        assert_eq!(kept.len(), 1);
    }

    #[test]
    fn note_backed_ical_series_ids_collects_only_ical_notes_with_body() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        let events_dir = crate::vault::events_dir(&vault);
        std::fs::create_dir_all(&events_dir).unwrap();
        std::fs::write(
            events_dir.join("e_gcal_abc123abc123_20260604.md"),
            "---\ntype: event\nprovider: ical\n---\n\nMeeting notes\n",
        )
        .unwrap();
        std::fs::write(
            events_dir.join("e_gcal_emptyempty.md"),
            "---\ntype: event\nprovider: ical\n---\n\n",
        )
        .unwrap();
        std::fs::write(
            events_dir.join("e_local.md"),
            "---\ntype: event\n---\n\nMeeting notes\n",
        )
        .unwrap();

        let got = note_backed_ical_series_ids(&vault);
        assert!(got.contains("e_gcal_abc123abc123"));
        assert!(!got.contains("e_gcal_emptyempty"));
        assert!(!got.contains("e_local"));
    }

    #[test]
    fn events_for_date_honors_exdate() {
        let cache = IcalEventCache::new();
        let mut ev = sample_ical(
            "deleted-occurrence",
            "2026-05-08T15:00:00+00:00",
            RecurringRule::Weekly,
        );
        ev.exdates = vec!["2026-05-22".to_string()];
        cache.set("gcal_A".to_string(), vec![ev]);

        let normal = NaiveDate::from_ymd_opt(2026, 5, 15).unwrap();
        assert_eq!(cache.events_for_date(normal).len(), 1);
        let deleted = NaiveDate::from_ymd_opt(2026, 5, 22).unwrap();
        assert!(cache.events_for_date(deleted).is_empty());
    }

    #[test]
    fn cleanup_sweeps_only_gcal_prefixed_files() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        let cadence = crate::vault::cadence_dir(&vault);
        std::fs::create_dir_all(&cadence).unwrap();
        // Vault-local: must survive.
        std::fs::write(cadence.join("alex-1-1-2026-05-11.md"), "x").unwrap();
        std::fs::write(cadence.join("standup-2026-05-12.md"), "x").unwrap();
        // Legacy iCal cache files: must be deleted.
        std::fs::write(cadence.join("gcal-abc123def456.md"), "x").unwrap();
        std::fs::write(cadence.join("gcal-xyz789.md"), "x").unwrap();

        let deleted = cleanup_legacy_cadence_files(&vault).unwrap();
        assert_eq!(deleted, 2);
        assert!(cadence.join("alex-1-1-2026-05-11.md").exists());
        assert!(cadence.join("standup-2026-05-12.md").exists());
        assert!(!cadence.join("gcal-abc123def456.md").exists());
        assert!(!cadence.join("gcal-xyz789.md").exists());
    }

    #[test]
    fn cleanup_is_idempotent_on_empty_vault() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::create_dir_all(crate::vault::cadence_dir(&vault)).unwrap();
        assert_eq!(cleanup_legacy_cadence_files(&vault).unwrap(), 0);
        // Second call also finds nothing — no errors, no false positives.
        assert_eq!(cleanup_legacy_cadence_files(&vault).unwrap(), 0);
    }

    fn placeholder_file(title: &str, id: &str) -> String {
        format!(
            "---\ntype: event\nid: {id}\ntitle: {title}\ndate: 2026-04-29T07:00:00-07:00\nduration: 60\narea: personal\nattendees: []\nrecurring: none\n---\n\nSynced from Google Calendar (Work).\nEvent: {id}\n"
        )
    }

    #[test]
    fn legacy_per_event_sweep_deletes_placeholders_only() {
        // Three legacy g_*.md placeholder files (must go) +
        // one with real notes (must survive) +
        // one with the same prefix but non-matching id shape (survives).
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        let events = crate::vault::events_dir(&vault);
        std::fs::create_dir_all(&events).unwrap();

        let placeholder_ids = [
            "g_work_2ejaiev1pcsl4vlvpg54g13de7_20260429T153000Z",
            "g_personal_ag8u5oarocsnqv1i8fpaeec0gl_20260429T140000Z",
            "g_work_jaif3kffldcp6lu0ascjt128sp_20260429T150000Z",
        ];
        for id in &placeholder_ids {
            std::fs::write(
                events.join(format!("{id}.md")),
                placeholder_file("Project Sync", id),
            )
            .unwrap();
        }

        // Same prefix + placeholder body but the user wrote real notes.
        let with_notes_id = "g_work_keep_me_20260429T160000Z";
        let body_with_notes = format!(
            "---\ntype: event\nid: {with_notes_id}\ntitle: Important\ndate: 2026-04-29T09:00:00-07:00\nduration: 30\narea: personal\nattendees: []\nrecurring: none\n---\n\nSynced from Google Calendar (Work).\nEvent: {with_notes_id}\n\nMy actual meeting notes about the conversation."
        );
        std::fs::write(events.join(format!("{with_notes_id}.md")), body_with_notes).unwrap();

        // Vault-local event with an unrelated name — must survive.
        std::fs::write(
            events.join("e_01HM3Z.md"),
            "---\ntype: event\nid: e_01HM3Z\ntitle: Vault local\ndate: 2026-04-29T10:00:00-07:00\nduration: 30\nrecurring: none\n---\n\n",
        )
        .unwrap();

        // Current-format iCal notes attachment — must survive.
        std::fs::write(
            events.join("e_gcal_abc123def456.md"),
            "---\ntype: event\nid: e_gcal_abc123def456\ntitle: cached\ndate: 2026-04-29T11:00:00-07:00\nduration: 30\nprovider: ical\nrecurring: none\n---\n\nNotes here.\n",
        )
        .unwrap();

        // File with the right prefix but wrong shape (no trailing
        // `_YYYYMMDDTHHMMSSZ`) — must survive.
        std::fs::write(
            events.join("g_legit_event_id.md"),
            placeholder_file("Looks legacy but isn't", "g_legit_event_id"),
        )
        .unwrap();

        let deleted = cleanup_legacy_per_event_files(&vault).unwrap();
        assert_eq!(deleted, 3);
        for id in &placeholder_ids {
            assert!(
                !events.join(format!("{id}.md")).exists(),
                "should have deleted {id}",
            );
        }
        assert!(events.join(format!("{with_notes_id}.md")).exists());
        assert!(events.join("e_01HM3Z.md").exists());
        assert!(events.join("e_gcal_abc123def456.md").exists());
        assert!(events.join("g_legit_event_id.md").exists());

        // Idempotent: re-run finds nothing.
        assert_eq!(cleanup_legacy_per_event_files(&vault).unwrap(), 0);
    }

    #[test]
    fn legacy_per_event_sweep_is_noop_on_missing_dir() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        // No events/ dir at all.
        assert_eq!(cleanup_legacy_per_event_files(&vault).unwrap(), 0);
    }

    #[test]
    fn is_legacy_per_event_id_matches_shape() {
        assert!(is_legacy_per_event_id(
            "g_work_2ejaiev1pcsl4vlvpg54g13de7_20260429T153000Z"
        ));
        assert!(is_legacy_per_event_id("g_personal_abc_20250101T000000Z"));
        // Wrong prefix.
        assert!(!is_legacy_per_event_id("e_gcal_abc123"));
        // Missing trailing Z.
        assert!(!is_legacy_per_event_id("g_work_abc_20260429T153000"));
        // Wrong length (15 not 16).
        assert!(!is_legacy_per_event_id("g_work_abc_2026042T153000Z"));
        // Letters in the date portion.
        assert!(!is_legacy_per_event_id("g_work_abc_2026abcdT153000Z"));
    }

    #[test]
    fn placeholder_body_accepts_synced_stub() {
        let content = "---\ntype: event\nid: g_work_abc_20260429T140000Z\n---\n\nSynced from Google Calendar (Work).\nEvent: abc_20260429T140000Z";
        assert!(is_auto_generated_placeholder_body(content));
    }

    #[test]
    fn placeholder_body_accepts_empty_body() {
        let content = "---\ntype: event\nid: g_work_abc_20260429T140000Z\n---\n";
        assert!(is_auto_generated_placeholder_body(content));
    }

    #[test]
    fn placeholder_body_rejects_user_notes() {
        // Auto-stub + a user line ⇒ keep.
        let content = "---\ntype: event\nid: g_work_abc_20260429T140000Z\n---\n\nSynced from Google Calendar (Work).\nEvent: abc\n\nThis is what I noted in the meeting.";
        assert!(!is_auto_generated_placeholder_body(content));
        // Just user notes, no auto stub ⇒ also keep.
        let content = "---\ntype: event\nid: g_work_abc_20260429T140000Z\n---\n\nMy notes only.";
        assert!(!is_auto_generated_placeholder_body(content));
    }
}
