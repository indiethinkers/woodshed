// .ics → typed events. The `ical` crate gives us a stream of properties
// per VEVENT; this module flattens those into a shape that matches
// Woodshed's existing `Event` schema, with two intentionally lossy
// reductions:
//
//   - RRULE lowers to the existing `recurring: none|daily|weekly|monthly`
//     enum when it's simple enough; recurrence bounds/exclusions
//     (UNTIL/COUNT/EXDATE) and common modifiers (BYDAY/INTERVAL) are
//     preserved on `IcalEvent` for the projection layer. Phase 2b's
//     OAuth write path uses the original string so we don't lose
//     recurrence data we can't render.
//
//   - Exotic TZIDs (uncommon Olson zones, custom VTIMEZONE bodies)
//     fall back to UTC. The common Google Calendar shape is either
//     `DTSTART:20260511T083000Z` (UTC, no TZID) or
//     `DTSTART;TZID=America/New_York:20260511T083000`, both of which
//     we handle cleanly.

use crate::parsers::RecurringRule;
use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Deserializer, Serialize};
use std::io::BufReader;

/// Flat in-process representation of a single VEVENT, ready to be
/// promoted into a `parsers::Event`. Mirrors the field names we care
/// about so the sync layer doesn't have to know about ical-crate types.
/// Serializable for the JSON cache at <app_data_dir>/gcal-cache/<id>.json.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attendee {
    pub email: String,
    /// `PARTSTAT` parameter from the iCal ATTENDEE property —
    /// `NEEDS-ACTION` | `ACCEPTED` | `DECLINED` | `TENTATIVE` |
    /// `DELEGATED`. The sync uses `DECLINED` to drop events the user
    /// has rejected (matches Google Calendar's default of hiding
    /// declined events from the UI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partstat: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IcalEvent {
    pub uid: String,
    pub summary: String,
    pub description: String,
    /// Start time as RFC 3339 with offset. For all-day events this is
    /// `YYYY-MM-DDT00:00:00+00:00`.
    pub dtstart_rfc3339: String,
    pub duration_minutes: u32,
    /// Lowered to the small enum the existing renderer understands;
    /// `None` when the RRULE was too complex (or absent).
    pub recurring_enum: RecurringRule,
    /// Raw RRULE line preserved verbatim when present (whether or not
    /// `recurring_enum` could capture it). Includes the `RRULE:` prefix.
    pub rrule_original: Option<String>,
    /// The `UNTIL=` bound from RRULE. Date-only values are normalized
    /// to `YYYY-MM-DD`; date-time values are normalized to RFC 3339.
    /// When present, the recurrence stops at this bound. Without this,
    /// old weekly meetings that ended months ago ghost-project onto
    /// every future Monday.
    #[serde(default)]
    pub rrule_until: Option<String>,
    /// The `COUNT=` bound from RRULE. Projection drops master
    /// occurrences after this many generated instances.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rrule_count: Option<u32>,
    /// `BYDAY=` weekday list from RRULE, normalized to two-letter codes
    /// (`MO`/`TU`/`WE`/`TH`/`FR`/`SA`/`SU`). Empty when absent. Lets
    /// weekly projection fan out to multiple days per week (e.g. a
    /// standup that fires Tue + Thu off a Tuesday anchor). The two-
    /// letter form is what RFC 5545 uses; we drop any `+1`/`-1` prefix
    /// (BYSETPOS) since the small enum can't express it.
    #[serde(default, deserialize_with = "vec_or_default")]
    pub rrule_byday: Vec<String>,
    /// `INTERVAL=` value from RRULE, defaulting to 1. Used together
    /// with `recurring_enum` to express bi-weekly (`INTERVAL=2` +
    /// Weekly) and similar cadences our small enum couldn't otherwise
    /// represent. Projection counts weeks/months since the anchor and
    /// skips occurrences where `diff % interval != 0`.
    #[serde(default = "default_interval")]
    pub rrule_interval: u32,
    /// `EXDATE` occurrence dates, normalized to `YYYY-MM-DD`. Google
    /// uses these heavily when a user deletes a single instance from
    /// a recurring series.
    #[serde(
        default,
        deserialize_with = "vec_or_default",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub exdates: Vec<String>,
    pub location: Option<String>,
    pub attendees: Vec<Attendee>,
    /// Email of the event's organizer, with the `mailto:` prefix stripped.
    /// Parsed but not currently used for filtering — kept for future
    /// "you organized" badges or per-event filters.
    #[serde(default)]
    pub organizer_email: Option<String>,
    /// Single-instance overrides for this recurring series. Google
    /// Calendar emits these as separate VEVENTs that share the master
    /// UID and carry a `RECURRENCE-ID` naming the original occurrence
    /// they replace. Three shapes are common:
    ///
    ///   - Same-day time shift (user dragged this Thursday's instance
    ///     from 10:30 to 10:00).
    ///   - Move to a different day (this week's Thursday moved to
    ///     Friday).
    ///   - Single-instance cancellation (this week is skipped).
    ///
    /// Empty for non-recurring events and for series without
    /// per-instance edits. Attached to the master at parse time so
    /// projection has everything it needs in one record.
    #[serde(default, deserialize_with = "vec_or_default")]
    pub overrides: Vec<RecurrenceOverride>,
}

fn vec_or_default<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

/// A single-instance override that replaces (or removes) one
/// occurrence of a recurring master event. Identified by the original
/// occurrence's date (from `RECURRENCE-ID`); applied at projection
/// time to either suppress the master's emission or substitute the
/// override's metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecurrenceOverride {
    /// The original occurrence's date in `YYYY-MM-DD`, derived from
    /// the `RECURRENCE-ID` property (normalized to UTC). The master's
    /// projection on this date is replaced by — or, for cancellations,
    /// suppressed without — this override.
    pub original_date: String,
    /// New start time as RFC 3339, when the instance was moved. `None`
    /// for cancellations.
    #[serde(default)]
    pub dtstart_rfc3339: Option<String>,
    /// New duration if the override changed it. `None` ⇒ inherit from
    /// master.
    #[serde(default)]
    pub duration_minutes: Option<u32>,
    /// Overridden summary, when the user retitled this single instance.
    /// `None` ⇒ inherit from master.
    #[serde(default)]
    pub summary: Option<String>,
    /// True when the override is a `STATUS:CANCELLED` per-instance
    /// drop — the original occurrence is removed, no replacement.
    #[serde(default)]
    pub cancelled: bool,
}

impl IcalEvent {
    /// Did the user decline this event under any of their addresses?
    /// Returns false when `user_emails` is empty (no addresses
    /// configured ⇒ nothing to compare).
    pub fn user_declined(&self, user_emails: &[String]) -> bool {
        if user_emails.is_empty() {
            return false;
        }
        self.attendees.iter().any(|a| {
            email_matches_any(&a.email, user_emails)
                && a.partstat
                    .as_deref()
                    .map(|s| s.eq_ignore_ascii_case("DECLINED"))
                    .unwrap_or(false)
        })
    }

    /// Is the user personally involved in this event — either as
    /// organizer or attendee — under any of their addresses? Returns
    /// true when `user_emails` is empty (no addresses configured ⇒ no
    /// filter). Used by the sync to drop events the user is merely a
    /// calendar viewer of (e.g. "Program Ops only" meetings that
    /// surface in a shared calendar's iCal feed but list the user
    /// nowhere).
    pub fn user_involved(&self, user_emails: &[String]) -> bool {
        if user_emails.is_empty() {
            return true;
        }
        if let Some(org) = &self.organizer_email {
            if email_matches_any(org, user_emails) {
                return true;
            }
        }
        self.attendees
            .iter()
            .any(|a| email_matches_any(&a.email, user_emails))
    }
}

fn email_matches_any(email: &str, candidates: &[String]) -> bool {
    candidates.iter().any(|c| email.eq_ignore_ascii_case(c))
}

fn default_interval() -> u32 {
    1
}

#[derive(Debug, thiserror::Error)]
pub enum IcalError {
    #[error("iCal parse error: {0}")]
    Parse(String),
    #[error("VEVENT missing required UID")]
    MissingUid,
    #[error("VEVENT missing required DTSTART")]
    MissingDtstart,
}

/// Parse a full .ics document into events.
///
/// Two-pass:
///   - Pass 1 collects every VEVENT into either a *master* (no
///     `RECURRENCE-ID`, kept as `IcalEvent`) or an *override* (has
///     `RECURRENCE-ID`, kept as `RecurrenceOverride` keyed by UID).
///     Top-level `STATUS:CANCELLED` events (whole-series deletions)
///     drop here; per-instance cancellations get a `cancelled=true`
///     override so the projection layer can suppress just that
///     occurrence.
///   - Pass 2 attaches every override to its master by UID. Overrides
///     whose master is missing from the feed get dropped (the master
///     was likely declined/uninvolved-filtered upstream and the
///     override is meaningless without it).
///
/// Masters are deduped by UID — a feed that somehow contains two
/// non-override VEVENTs with the same UID keeps the first.
///
/// Errors at the document level abort the whole feed; per-event parse
/// failures get logged via stderr and skipped so one weird event doesn't
/// poison the sync.
pub fn parse_feed(bytes: &[u8]) -> Result<Vec<IcalEvent>, IcalError> {
    let reader = BufReader::new(bytes);
    let parser = ical::IcalParser::new(reader);

    let mut masters: Vec<IcalEvent> = Vec::new();
    let mut seen_uids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut overrides_by_uid: std::collections::HashMap<String, Vec<RecurrenceOverride>> =
        std::collections::HashMap::new();

    for cal_result in parser {
        let cal = cal_result.map_err(|e| IcalError::Parse(e.to_string()))?;
        for vevent in cal.events {
            match parse_vevent(&vevent) {
                Ok(ParsedVevent::Master(event)) => {
                    if seen_uids.insert(event.uid.clone()) {
                        masters.push(event);
                    }
                }
                Ok(ParsedVevent::Override { uid, ov }) => {
                    overrides_by_uid.entry(uid).or_default().push(ov);
                }
                Ok(ParsedVevent::Skip) => {}
                Err(e) => eprintln!("gcal: skipping VEVENT: {e}"),
            }
        }
    }

    for master in masters.iter_mut() {
        if let Some(overrides) = overrides_by_uid.remove(&master.uid) {
            master.overrides = overrides;
        }
    }
    Ok(masters)
}

/// Internal classification of a parsed VEVENT — either a master event
/// (kept as an `IcalEvent`), a per-instance override (attached to its
/// master in `parse_feed`'s second pass), or a skip (whole-series
/// cancellation with no `RECURRENCE-ID`).
enum ParsedVevent {
    Master(IcalEvent),
    Override { uid: String, ov: RecurrenceOverride },
    Skip,
}

fn parse_vevent(
    vevent: &ical::parser::ical::component::IcalEvent,
) -> Result<ParsedVevent, IcalError> {
    let mut uid: Option<String> = None;
    let mut summary = String::new();
    let mut description = String::new();
    let mut dtstart_raw: Option<(String, Option<String>)> = None;
    let mut dtend_raw: Option<(String, Option<String>)> = None;
    let mut duration_iso: Option<String> = None;
    let mut rrule: Option<String> = None;
    let mut exdate_raw: Vec<(String, Option<String>)> = Vec::new();
    let mut location: Option<String> = None;
    let mut attendees: Vec<Attendee> = Vec::new();
    let mut status: Option<String> = None;
    let mut organizer_email: Option<String> = None;
    let mut recurrence_id: Option<(String, Option<String>)> = None;

    for prop in &vevent.properties {
        let value = prop.value.clone().unwrap_or_default();
        match prop.name.as_str() {
            "UID" => uid = Some(value),
            "SUMMARY" => summary = unescape_text(&value),
            "DESCRIPTION" => description = unescape_text(&value),
            "DTSTART" => dtstart_raw = Some((value, tzid_param(prop))),
            "DTEND" => dtend_raw = Some((value, tzid_param(prop))),
            "DURATION" => duration_iso = Some(value),
            "RRULE" => rrule = Some(value),
            "EXDATE" => exdate_raw.push((value, tzid_param(prop))),
            "LOCATION" => location = Some(unescape_text(&value)),
            "ATTENDEE" => {
                // Values look like `mailto:name@host`. PARTSTAT is a
                // parameter on the property — we keep it alongside the
                // email so the sync filter can skip events the user
                // declined.
                let email = value.trim_start_matches("mailto:").trim().to_string();
                if email.is_empty() {
                    continue;
                }
                let partstat = prop.params.as_ref().and_then(|params| {
                    params
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case("PARTSTAT"))
                        .and_then(|(_, vals)| vals.first().cloned())
                });
                attendees.push(Attendee { email, partstat });
            }
            "STATUS" => status = Some(value),
            "RECURRENCE-ID" => recurrence_id = Some((value, tzid_param(prop))),
            "ORGANIZER" => {
                // Value is `mailto:foo@bar.com`. Drop the scheme; rare
                // legacy feeds omit it entirely.
                let clean = value.trim_start_matches("mailto:").to_string();
                if !clean.is_empty() {
                    organizer_email = Some(clean);
                }
            }
            _ => {}
        }
    }

    let is_cancelled = status
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("CANCELLED"))
        .unwrap_or(false);

    // Recurrence-instance override: a modified or deleted single
    // occurrence of a recurring series. Identified by `RECURRENCE-ID`
    // naming the original occurrence's start time, plus the same UID
    // as the master. Routed back to `parse_feed`, which attaches the
    // override to the master event so projection can emit/suppress
    // the right occurrence on the right date.
    if let Some((rid_value, rid_tzid)) = recurrence_id {
        let uid = uid.ok_or(IcalError::MissingUid)?;
        let original_date = parse_ical_datetime(&rid_value, rid_tzid.as_deref())
            .map(|(dt, _)| dt.format("%Y-%m-%d").to_string())
            .ok_or_else(|| IcalError::Parse(format!("bad RECURRENCE-ID {rid_value:?}")))?;

        // A pure cancellation override has no DTSTART payload — just
        // STATUS:CANCELLED + RECURRENCE-ID. Tolerate that.
        let (new_dtstart_rfc3339, new_duration) = if let Some((v, t)) = dtstart_raw {
            match parse_ical_datetime(&v, t.as_deref()) {
                Some((dt_utc, is_all_day)) => {
                    let duration = compute_duration_minutes(
                        &dt_utc,
                        dtend_raw.as_ref().map(|(v, t)| (v.as_str(), t.as_deref())),
                        duration_iso.as_deref(),
                        is_all_day,
                    );
                    (Some(dt_utc.to_rfc3339()), Some(duration))
                }
                None => (None, None),
            }
        } else {
            (None, None)
        };

        let override_summary = if summary.is_empty() {
            None
        } else {
            Some(summary)
        };

        return Ok(ParsedVevent::Override {
            uid,
            ov: RecurrenceOverride {
                original_date,
                dtstart_rfc3339: new_dtstart_rfc3339,
                duration_minutes: new_duration,
                summary: override_summary,
                cancelled: is_cancelled,
            },
        });
    }

    // Whole-series cancellation (no RECURRENCE-ID): drop entirely.
    if is_cancelled {
        return Ok(ParsedVevent::Skip);
    }

    let uid = uid.ok_or(IcalError::MissingUid)?;
    let (dtstart_value, dtstart_tzid) = dtstart_raw.ok_or(IcalError::MissingDtstart)?;

    let (dtstart_utc, is_all_day) = parse_ical_datetime(&dtstart_value, dtstart_tzid.as_deref())
        .ok_or_else(|| IcalError::Parse(format!("bad DTSTART {dtstart_value:?}")))?;

    let duration_minutes = compute_duration_minutes(
        &dtstart_utc,
        dtend_raw.as_ref().map(|(v, t)| (v.as_str(), t.as_deref())),
        duration_iso.as_deref(),
        is_all_day,
    );

    let (recurring_enum, rrule_original, rrule_until, rrule_count, rrule_byday, rrule_interval) =
        match rrule {
            Some(rule) => (
                lower_rrule_to_enum(&rule),
                Some(format!("RRULE:{rule}")),
                extract_until(&rule),
                extract_count(&rule),
                extract_byday(&rule),
                extract_interval(&rule),
            ),
            None => (RecurringRule::None, None, None, None, Vec::new(), 1),
        };

    Ok(ParsedVevent::Master(IcalEvent {
        uid,
        summary,
        description,
        dtstart_rfc3339: dtstart_utc.to_rfc3339(),
        duration_minutes,
        recurring_enum,
        rrule_original,
        rrule_until,
        rrule_count,
        rrule_byday,
        rrule_interval,
        exdates: normalize_exdates(&exdate_raw),
        location,
        attendees,
        organizer_email,
        overrides: Vec::new(),
    }))
}

/// Extract the `UNTIL` bound from an RRULE *value* (the part after
/// `RRULE:`). Returns `YYYY-MM-DD` for date-only bounds and RFC 3339
/// for date-time bounds. Keeping the instant matters: Google often
/// ends a weekly series at `06:59:59Z` on the same date as a later
/// local occurrence, and treating that as the whole day resurrects
/// deleted meetings.
fn extract_until(value: &str) -> Option<String> {
    for part in value.split(';') {
        let (k, v) = part.split_once('=')?;
        if k != "UNTIL" {
            continue;
        }
        let v = v.trim();
        if v.contains('T') {
            let raw = v.trim_end_matches('Z');
            let naive = NaiveDateTime::parse_from_str(raw, "%Y%m%dT%H%M%S").ok()?;
            return Some(Utc.from_utc_datetime(&naive).to_rfc3339());
        }
        if v.len() != 8 || !v.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let y = &v[0..4];
        let m = &v[4..6];
        let d = &v[6..8];
        return Some(format!("{y}-{m}-{d}"));
    }
    None
}

/// Extract the `COUNT=` bound from an RRULE value. Invalid or zero
/// counts are ignored; Google emits positive values for real feeds.
fn extract_count(value: &str) -> Option<u32> {
    for part in value.split(';') {
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        if k != "COUNT" {
            continue;
        }
        let n = v.trim().parse::<u32>().ok()?;
        return (n > 0).then_some(n);
    }
    None
}

/// Pull the TZID parameter off a property, if present. Parameters are
/// stored as `Vec<(String, Vec<String>)>` keyed by name — TZID always
/// has one value.
fn tzid_param(prop: &ical::property::Property) -> Option<String> {
    prop.params.as_ref().and_then(|params| {
        params
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("TZID"))
            .and_then(|(_, values)| values.first().cloned())
    })
}

/// Parse an iCal date/datetime string into a UTC chrono datetime.
/// Returns `(datetime, is_all_day)`. Handles:
///   - `20260511`                (date-only → all-day, 00:00 UTC)
///   - `20260511T083000Z`        (UTC datetime)
///   - `20260511T083000` + TZID  (zoned datetime → converted to UTC)
///   - `20260511T083000`         (floating → assumed UTC)
fn parse_ical_datetime(value: &str, tzid: Option<&str>) -> Option<(chrono::DateTime<Utc>, bool)> {
    let value = value.trim();
    // Date-only (8 chars, all digits) → all-day at 00:00 UTC.
    if value.len() == 8 && value.chars().all(|c| c.is_ascii_digit()) {
        let date = NaiveDate::parse_from_str(value, "%Y%m%d").ok()?;
        let dt = date.and_hms_opt(0, 0, 0)?;
        return Some((Utc.from_utc_datetime(&dt), true));
    }

    // Strip trailing Z to indicate explicit UTC; otherwise floating/zoned.
    let (raw, is_utc_z) = if let Some(stripped) = value.strip_suffix('Z') {
        (stripped, true)
    } else {
        (value, false)
    };

    let naive = NaiveDateTime::parse_from_str(raw, "%Y%m%dT%H%M%S").ok()?;

    if is_utc_z {
        return Some((Utc.from_utc_datetime(&naive), false));
    }

    // TZID-anchored: try chrono-tz. Unknown zones fall back to UTC.
    if let Some(zone_name) = tzid {
        if let Ok(tz) = zone_name.parse::<Tz>() {
            if let chrono::LocalResult::Single(zoned) = tz.from_local_datetime(&naive) {
                return Some((zoned.with_timezone(&Utc), false));
            }
        }
    }
    // Floating or unknown TZID — assume UTC. Loses correctness for
    // edge cases but keeps the event renderable; Phase 2b (OAuth)
    // can roundtrip the original through the event's date string.
    Some((Utc.from_utc_datetime(&naive), false))
}

/// Compute the event duration in minutes. Prefers DTEND - DTSTART; falls
/// back to ISO-8601 DURATION; falls back to defaults (60 min for timed,
/// 1440 min for all-day) when neither is present.
fn compute_duration_minutes(
    dtstart: &chrono::DateTime<Utc>,
    dtend: Option<(&str, Option<&str>)>,
    duration_iso: Option<&str>,
    is_all_day: bool,
) -> u32 {
    if let Some((value, tzid)) = dtend {
        if let Some((end, _)) = parse_ical_datetime(value, tzid) {
            let delta = end.signed_duration_since(*dtstart);
            let minutes = delta.num_minutes();
            if minutes > 0 {
                return minutes.min(u32::MAX as i64) as u32;
            }
        }
    }
    if let Some(iso) = duration_iso {
        if let Some(m) = parse_duration_iso(iso) {
            return m;
        }
    }
    if is_all_day {
        1440
    } else {
        60
    }
}

/// Parse a tiny subset of ISO 8601 duration (`PT1H30M`, `PT15M`, `P1D`).
/// Returns minutes. Best-effort: anything unparseable returns None and
/// the caller falls back to a default.
fn parse_duration_iso(s: &str) -> Option<u32> {
    let s = s.trim();
    if !s.starts_with('P') {
        return None;
    }
    let mut minutes: u32 = 0;
    let mut num = String::new();
    let mut in_time = false;
    for c in s[1..].chars() {
        if c == 'T' {
            in_time = true;
            num.clear();
            continue;
        }
        if c.is_ascii_digit() {
            num.push(c);
            continue;
        }
        let n: u32 = num.parse().ok()?;
        num.clear();
        let inc = match (in_time, c) {
            (false, 'D') => n.checked_mul(24)?.checked_mul(60)?,
            (false, 'W') => n.checked_mul(7)?.checked_mul(24)?.checked_mul(60)?,
            (true, 'H') => n.checked_mul(60)?,
            (true, 'M') => n,
            (true, 'S') => n / 60,
            _ => return None,
        };
        minutes = minutes.checked_add(inc)?;
    }
    Some(minutes)
}

/// Lower an RRULE *value* (the part after `RRULE:`) to the small enum
/// the existing renderer understands.
///
/// Permissive on purpose: Google Calendar's iCal feeds nearly always
/// attach `BYDAY`, `UNTIL`, `INTERVAL`, or `COUNT` to an otherwise-
/// simple weekly or monthly recurrence (e.g. `FREQ=WEEKLY;BYDAY=MO;
/// UNTIL=...`). Treating those as "too complex" means events only
/// show on their first-occurrence date — a strict-better-than-nothing
/// approach is to accept any single-frequency rule and let the cache
/// projection layer (in `cache::events_for_date`) honor the extra
/// parameters (BYDAY, INTERVAL, UNTIL) via `extract_byday` /
/// `extract_interval` / `extract_until`.
///
/// Remaining limitations:
///   - `FREQ=YEARLY` → dropped (no enum variant). The original RRULE
///     string is preserved for a future richer recurrence model.
///   - Monthly BYDAY (`FREQ=MONTHLY;BYDAY=2TU` — "second Tuesday") →
///     projects on the anchor's day-of-month, ignoring the BYDAY.
fn lower_rrule_to_enum(value: &str) -> RecurringRule {
    let mut freq: Option<&str> = None;
    for part in value.split(';') {
        let (k, v) = match part.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        if k == "FREQ" {
            freq = Some(v.trim());
        }
        // Other modifiers (BYDAY, UNTIL, INTERVAL, COUNT, BYMONTHDAY,
        // BYSETPOS, etc.) are tolerated — captured by sibling
        // extractors and honored at projection time.
    }
    match freq {
        Some("DAILY") => RecurringRule::Daily,
        Some("WEEKLY") => RecurringRule::Weekly,
        Some("MONTHLY") => RecurringRule::Monthly,
        _ => RecurringRule::None,
    }
}

/// Extract the `BYDAY=` weekday list from an RRULE value. Returns the
/// two-letter codes (`MO`/`TU`/`WE`/`TH`/`FR`/`SA`/`SU`). Strips any
/// `+1`/`-1`/`+2` BYSETPOS prefix — RFC 5545 lets you write
/// `BYDAY=2TU` for "second Tuesday of the month"; we keep just the day
/// and lose the position (acceptable for the small recurrence model).
fn extract_byday(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in value.split(';') {
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        if k != "BYDAY" {
            continue;
        }
        for day in v.split(',') {
            let day = day.trim();
            if day.is_empty() {
                continue;
            }
            // Drop leading sign + digits (BYSETPOS prefix); keep the
            // trailing two-letter weekday code.
            let trimmed: String = day
                .chars()
                .skip_while(|c| c.is_ascii_digit() || *c == '+' || *c == '-')
                .collect();
            let upper = trimmed.to_uppercase();
            if matches!(
                upper.as_str(),
                "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"
            ) {
                out.push(upper);
            }
        }
        break;
    }
    out
}

/// Extract `INTERVAL=` from an RRULE value. Defaults to 1 when absent
/// (the RFC 5545 default). Non-positive or unparseable values fall
/// back to 1 — better to overshoot than silently drop the recurrence.
fn extract_interval(value: &str) -> u32 {
    for part in value.split(';') {
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        if k != "INTERVAL" {
            continue;
        }
        if let Ok(n) = v.trim().parse::<u32>() {
            if n >= 1 {
                return n;
            }
        }
        return 1;
    }
    1
}

fn normalize_exdates(values: &[(String, Option<String>)]) -> Vec<String> {
    let mut out = Vec::new();
    for (value, tzid) in values {
        for raw in value.split(',') {
            if let Some((dt, _)) = parse_ical_datetime(raw.trim(), tzid.as_deref()) {
                out.push(dt.format("%Y-%m-%d").to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Reverse iCal text-escaping: `\\n`, `\\,`, `\\;`, `\\\\`.
/// Per RFC 5545 §3.3.11, commas and semicolons are field separators
/// inside parameter values, so they get backslash-escaped. Newlines
/// are encoded as `\\n`. We only need to handle these four — exotic
/// values like emoji and unicode pass through fine.
fn unescape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(',') => out.push(','),
                Some(';') => out.push(';'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rrule_freq_daily_lowers_to_daily() {
        assert_eq!(lower_rrule_to_enum("FREQ=DAILY"), RecurringRule::Daily);
    }

    #[test]
    fn rrule_freq_weekly_lowers_to_weekly() {
        assert_eq!(lower_rrule_to_enum("FREQ=WEEKLY"), RecurringRule::Weekly);
    }

    #[test]
    fn rrule_weekly_with_until_keeps_weekly() {
        // Permissive: UNTIL bounds the recurrence, but our enum can't
        // express the bound. We keep Weekly; the bound is extracted
        // separately into IcalEvent.rrule_until and enforced in
        // cache::events_for_date so events that ended in the past
        // don't ghost-project onto every future Monday.
        assert_eq!(
            lower_rrule_to_enum("FREQ=WEEKLY;UNTIL=20261231T235959Z"),
            RecurringRule::Weekly,
        );
    }

    #[test]
    fn extract_until_handles_datetime_form() {
        assert_eq!(
            extract_until("FREQ=WEEKLY;UNTIL=20261231T235959Z"),
            Some("2026-12-31T23:59:59+00:00".to_string()),
        );
    }

    #[test]
    fn extract_until_handles_date_form() {
        assert_eq!(
            extract_until("FREQ=WEEKLY;UNTIL=20261231"),
            Some("2026-12-31".to_string()),
        );
    }

    #[test]
    fn extract_until_returns_none_when_absent() {
        assert_eq!(extract_until("FREQ=WEEKLY"), None);
        assert_eq!(extract_until("FREQ=DAILY;COUNT=10"), None);
    }

    #[test]
    fn extract_count_parses_positive_count() {
        assert_eq!(extract_count("FREQ=WEEKLY;COUNT=1;BYDAY=FR"), Some(1));
        assert_eq!(extract_count("FREQ=DAILY;COUNT=10"), Some(10));
        assert_eq!(extract_count("FREQ=WEEKLY"), None);
        assert_eq!(extract_count("FREQ=WEEKLY;COUNT=0"), None);
    }

    #[test]
    fn rrule_weekly_with_byday_keeps_weekly() {
        // BYDAY is the standard Google Calendar shape for weekly
        // recurrence. We project on the start date's weekday; multi-
        // day patterns (MO,WE,FR) only show on the start day.
        assert_eq!(
            lower_rrule_to_enum("FREQ=WEEKLY;BYDAY=MO,TU"),
            RecurringRule::Weekly,
        );
    }

    #[test]
    fn rrule_monthly_with_bymonthday_keeps_monthly() {
        assert_eq!(
            lower_rrule_to_enum("FREQ=MONTHLY;BYMONTHDAY=15"),
            RecurringRule::Monthly,
        );
    }

    #[test]
    fn rrule_interval_other_than_one_keeps_freq() {
        // INTERVAL=2 means every other week. We keep the FREQ enum
        // and stash the interval on IcalEvent.rrule_interval; the
        // cache projection counts weeks since the anchor and skips
        // off-cycle weeks.
        assert_eq!(
            lower_rrule_to_enum("FREQ=WEEKLY;INTERVAL=2"),
            RecurringRule::Weekly,
        );
        assert_eq!(extract_interval("FREQ=WEEKLY;INTERVAL=2"), 2);
    }

    #[test]
    fn extract_interval_defaults_to_one() {
        assert_eq!(extract_interval("FREQ=WEEKLY"), 1);
        assert_eq!(extract_interval("FREQ=WEEKLY;BYDAY=MO"), 1);
    }

    #[test]
    fn cached_event_accepts_null_array_fields() {
        let raw = r#"{
            "uid": "event-uid",
            "summary": "Design review",
            "description": "",
            "dtstart_rfc3339": "2026-06-08T17:00:00+00:00",
            "duration_minutes": 30,
            "recurring_enum": "none",
            "rrule_original": null,
            "rrule_until": null,
            "rrule_count": null,
            "rrule_byday": null,
            "rrule_interval": 1,
            "exdates": null,
            "location": null,
            "attendees": [],
            "organizer_email": null,
            "overrides": null
        }"#;
        let event: IcalEvent = serde_json::from_str(raw).unwrap();
        assert!(event.rrule_byday.is_empty());
        assert!(event.exdates.is_empty());
        assert!(event.overrides.is_empty());
    }

    #[test]
    fn extract_byday_parses_multi_day_list() {
        assert_eq!(
            extract_byday("FREQ=WEEKLY;BYDAY=MO,WE,FR"),
            vec!["MO".to_string(), "WE".to_string(), "FR".to_string()],
        );
    }

    #[test]
    fn extract_byday_strips_setpos_prefix() {
        // `BYDAY=2TU` is "second Tuesday of the month" — we drop the
        // position and keep just the weekday code.
        assert_eq!(
            extract_byday("FREQ=MONTHLY;BYDAY=2TU"),
            vec!["TU".to_string()],
        );
        assert_eq!(
            extract_byday("FREQ=MONTHLY;BYDAY=-1FR"),
            vec!["FR".to_string()],
        );
    }

    #[test]
    fn extract_byday_returns_empty_when_absent() {
        assert!(extract_byday("FREQ=WEEKLY").is_empty());
        assert!(extract_byday("FREQ=DAILY;COUNT=10").is_empty());
    }

    #[test]
    fn rrule_yearly_unsupported() {
        assert_eq!(lower_rrule_to_enum("FREQ=YEARLY"), RecurringRule::None);
    }

    #[test]
    fn parse_date_only_is_all_day_at_midnight() {
        let (dt, all_day) = parse_ical_datetime("20260511", None).unwrap();
        assert!(all_day);
        assert_eq!(dt.to_rfc3339(), "2026-05-11T00:00:00+00:00");
    }

    #[test]
    fn parse_utc_datetime() {
        let (dt, all_day) = parse_ical_datetime("20260511T083000Z", None).unwrap();
        assert!(!all_day);
        assert_eq!(dt.to_rfc3339(), "2026-05-11T08:30:00+00:00");
    }

    #[test]
    fn parse_tzid_converts_to_utc() {
        let (dt, _) = parse_ical_datetime("20260511T083000", Some("America/New_York")).unwrap();
        // EDT in May → UTC-4 → 12:30 UTC.
        assert_eq!(dt.to_rfc3339(), "2026-05-11T12:30:00+00:00");
    }

    #[test]
    fn parse_floating_falls_back_to_utc() {
        let (dt, all_day) = parse_ical_datetime("20260511T083000", None).unwrap();
        assert!(!all_day);
        assert_eq!(dt.to_rfc3339(), "2026-05-11T08:30:00+00:00");
    }

    #[test]
    fn duration_iso_parses_pt1h30m() {
        assert_eq!(parse_duration_iso("PT1H30M"), Some(90));
        assert_eq!(parse_duration_iso("PT15M"), Some(15));
        assert_eq!(parse_duration_iso("P1D"), Some(1440));
        assert_eq!(parse_duration_iso(""), None);
    }

    #[test]
    fn unescape_handles_common_sequences() {
        assert_eq!(unescape_text(r"line1\nline2"), "line1\nline2");
        assert_eq!(unescape_text(r"a\,b\;c"), "a,b;c");
        assert_eq!(unescape_text(r"\\path"), "\\path");
    }

    #[test]
    fn parse_feed_handles_minimal_vevent() {
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:abc@example.com\r\nSUMMARY:All Hands\r\nDTSTART:20260511T083000Z\r\nDTEND:20260511T093000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_feed(ics).unwrap();
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.uid, "abc@example.com");
        assert_eq!(ev.summary, "All Hands");
        assert_eq!(ev.dtstart_rfc3339, "2026-05-11T08:30:00+00:00");
        assert_eq!(ev.duration_minutes, 60);
        assert_eq!(ev.recurring_enum, RecurringRule::None);
        assert!(ev.rrule_original.is_none());
    }

    #[test]
    fn parse_feed_preserves_count_until_and_exdate() {
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:bounded\r\nSUMMARY:Bounded\r\nDTSTART;TZID=America/Los_Angeles:20260522T083000\r\nDTEND;TZID=America/Los_Angeles:20260522T090000\r\nRRULE:FREQ=WEEKLY;UNTIL=20260522T065959Z;COUNT=1;BYDAY=FR\r\nEXDATE;TZID=America/Los_Angeles:20260522T083000,20260529T083000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_feed(ics).unwrap();
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.rrule_until.as_deref(), Some("2026-05-22T06:59:59+00:00"));
        assert_eq!(ev.rrule_count, Some(1));
        assert_eq!(
            ev.exdates,
            vec!["2026-05-22".to_string(), "2026-05-29".to_string()],
        );
    }

    #[test]
    fn parse_feed_skips_cancelled_status() {
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Gone\r\nDTSTART:20260511T083000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert!(parse_feed(ics).unwrap().is_empty());
    }

    #[test]
    fn parse_feed_attaches_recurrence_overrides_to_master() {
        // Real-world Google Calendar shape: one master VEVENT with
        // RRULE, plus a separate VEVENT carrying the same UID and a
        // RECURRENCE-ID for an instance the user moved. The override
        // attaches to the master so projection can substitute its
        // time/title on that specific occurrence — and skip the
        // master's original projection for that date.
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:weekly-standup\r\nSUMMARY:Standup\r\nDTSTART:20260511T093000Z\r\nDTEND:20260511T094500Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:weekly-standup\r\nSUMMARY:Standup (moved)\r\nDTSTART:20260518T100000Z\r\nDTEND:20260518T101500Z\r\nRECURRENCE-ID:20260518T093000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_feed(ics).unwrap();
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.summary, "Standup");
        assert_eq!(ev.recurring_enum, RecurringRule::Weekly);
        assert_eq!(ev.overrides.len(), 1);
        let ov = &ev.overrides[0];
        assert_eq!(ov.original_date, "2026-05-18");
        assert_eq!(
            ov.dtstart_rfc3339.as_deref(),
            Some("2026-05-18T10:00:00+00:00"),
        );
        assert_eq!(ov.duration_minutes, Some(15));
        assert_eq!(ov.summary.as_deref(), Some("Standup (moved)"));
        assert!(!ov.cancelled);
    }

    #[test]
    fn parse_feed_captures_cancellation_override() {
        // Single-instance cancellation: master + a sibling VEVENT
        // with the same UID, STATUS:CANCELLED, and a RECURRENCE-ID
        // for the dropped occurrence. The override should land on
        // the master with cancelled=true so projection can suppress
        // just that date.
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:weekly\r\nSUMMARY:Standup\r\nDTSTART:20260511T093000Z\r\nDTEND:20260511T094500Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:weekly\r\nSTATUS:CANCELLED\r\nRECURRENCE-ID:20260518T093000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_feed(ics).unwrap();
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.overrides.len(), 1);
        assert_eq!(ev.overrides[0].original_date, "2026-05-18");
        assert!(ev.overrides[0].cancelled);
        assert!(ev.overrides[0].dtstart_rfc3339.is_none());
    }

    #[test]
    fn parse_feed_drops_whole_series_cancellation() {
        // STATUS:CANCELLED without a RECURRENCE-ID still drops the
        // event entirely — that's a whole-series delete.
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:gone\r\nSUMMARY:Removed series\r\nDTSTART:20260511T093000Z\r\nRRULE:FREQ=WEEKLY\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert!(parse_feed(ics).unwrap().is_empty());
    }

    #[test]
    fn parse_feed_captures_attendee_partstat() {
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Standup\r\nDTSTART:20260511T093000Z\r\nATTENDEE;PARTSTAT=DECLINED;CN=Alex:mailto:alex@example.com\r\nATTENDEE;PARTSTAT=ACCEPTED;CN=Sam:mailto:sam@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_feed(ics).unwrap();
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.attendees.len(), 2);
        let alex = &ev.attendees[0];
        assert_eq!(alex.email, "alex@example.com");
        assert_eq!(alex.partstat.as_deref(), Some("DECLINED"));
        let sam = &ev.attendees[1];
        assert_eq!(sam.email, "sam@example.com");
        assert_eq!(sam.partstat.as_deref(), Some("ACCEPTED"));
        // And the helper for the sync filter.
        let alex_emails = vec!["alex@example.com".to_string()];
        let sam_emails = vec!["sam@example.com".to_string()];
        assert!(ev.user_declined(&alex_emails));
        assert!(!ev.user_declined(&sam_emails));
    }

    #[test]
    fn parse_feed_dedupes_by_uid() {
        // Defensive: two VEVENTs with the same UID but neither a
        // RECURRENCE-ID override. Shouldn't happen in well-formed
        // feeds, but if it does (e.g., a sync/merge bug upstream),
        // keep the first to avoid visible duplicates.
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:dup\r\nSUMMARY:First\r\nDTSTART:20260511T083000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:dup\r\nSUMMARY:Second\r\nDTSTART:20260511T093000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_feed(ics).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].summary, "First");
    }

    #[test]
    fn parse_feed_preserves_complex_rrule() {
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:r\r\nSUMMARY:Standup\r\nDTSTART:20260511T093000Z\r\nDTEND:20260511T094500Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_feed(ics).unwrap();
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        // FREQ=WEEKLY lowers to Weekly even with BYDAY; the original
        // RRULE line is preserved so Phase 2b's richer recurrence
        // engine can replay the exact pattern when it lands.
        assert_eq!(ev.recurring_enum, RecurringRule::Weekly);
        assert_eq!(
            ev.rrule_original.as_deref(),
            Some("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"),
        );
    }
}
