// State: in-memory id→path map for events, plus a date-bucketed cache of
// parsed event payloads. Without the payload cache, every events_for_date
// call would `read_dir(events/)` + parse YAML for every file — 80-120ms on
// a vault with 2000+ events. Both structs are hydrated at watcher_start and
// maintained incrementally by event updates/deletes and calendar sync.
// External watcher events upsert the touched file.

use crate::parsers::{Event as ParsedEvent, EventProvider, RecurringRule};
use crate::sync_ext::{MutexRecover, RwLockRecover};
use chrono::NaiveDate;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

pub struct EventIndex {
    inner: Mutex<HashMap<String, PathBuf>>,
}

impl EventIndex {
    pub fn new() -> Self {
        EventIndex {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn insert(&self, id: String, path: PathBuf) {
        self.inner.lock_recover().insert(id, path);
    }

    pub fn get(&self, id: &str) -> Option<PathBuf> {
        self.inner.lock_recover().get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<PathBuf> {
        self.inner.lock_recover().remove(id)
    }

    pub fn clear(&self) {
        self.inner.lock_recover().clear();
    }
}

impl Default for EventIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// Lightweight identity record for one Person, used as the value type
/// of the email index. Kept minimal — the index gets read on every
/// attendee resolution (potentially thousands per cadence render), so
/// we don't want to copy the full ParsedPerson around.
#[derive(Debug, Clone)]
pub struct PersonRef {
    pub id: String,
    pub name: String,
    /// Lowercased on construction so attendee resolution doesn't have
    /// to re-normalize on every lookup. `None` when the person record
    /// has no email set (rare — most people have at least one).
    pub email: Option<String>,
    /// Area slug from the person's frontmatter (already a kebab id).
    /// `None` when unset. Feeds event-area inference — an event with no
    /// area borrows the area most of its attendees belong to.
    pub area: Option<String>,
}

/// Two parallel `HashMap`s — lookups by email AND by id, both
/// resolving to the same `PersonRef`. Built from every `people/*.md`
/// at startup and refreshed whenever a person file changes.
///
/// Powers attendee resolution for both flavors of event:
///   - vault-local events store attendees as person ids ⇒ `by_id`
///   - iCal events store attendees as raw email strings ⇒ `by_email`
///
/// With 2700+ events × ~10 attendees per cadence render and O(1)
/// per-attendee hashmap lookups, resolution adds well under a
/// millisecond to a full-month render. Built once per
/// startup / mutation rather than per request, so the read path
/// never pays the build cost.
///
/// One email maps to at most one person: if two people somehow share
/// an email in the vault, the last writer wins (deterministic by
/// file-system iteration order; collisions are pathological).
pub struct PeopleEmailIndex {
    by_email: RwLock<HashMap<String, PersonRef>>,
    by_id: RwLock<HashMap<String, PersonRef>>,
    /// Email-domain → area, derived from the people whose records carry
    /// both an email and an area. A domain maps to the area a majority
    /// of its people share. Generic free-mail providers (gmail, outlook,
    /// …) are excluded — they don't signal an organization — so an
    /// unknown `someone@acme.com` attendee can still borrow Acme's area
    /// while `someone@gmail.com` cannot. Backs event-area inference for
    /// attendees who aren't individually in the People folder.
    by_domain: RwLock<HashMap<String, String>>,
}

impl PeopleEmailIndex {
    pub fn new() -> Self {
        PeopleEmailIndex {
            by_email: RwLock::new(HashMap::new()),
            by_id: RwLock::new(HashMap::new()),
            by_domain: RwLock::new(HashMap::new()),
        }
    }

    /// Replace the entire index. Used at startup and on full rebuild.
    /// Pre-computes the `by_email`, `by_id`, and `by_domain` maps from
    /// one source.
    pub fn replace(&self, entries: Vec<PersonRef>) {
        let mut email: HashMap<String, PersonRef> = HashMap::with_capacity(entries.len());
        let mut id: HashMap<String, PersonRef> = HashMap::with_capacity(entries.len());
        // domain → (area → count); collapsed to a single majority area
        // per domain below.
        let mut domain_votes: HashMap<String, HashMap<String, usize>> = HashMap::new();
        for r in entries {
            id.insert(r.id.clone(), r.clone());
            if let Some(e) = r.email.as_ref() {
                let key = e.trim().to_ascii_lowercase();
                if !key.is_empty() {
                    if let (Some(domain), Some(area)) = (email_domain(&key), person_area(&r)) {
                        if !is_generic_email_domain(domain) {
                            *domain_votes
                                .entry(domain.to_string())
                                .or_default()
                                .entry(area)
                                .or_default() += 1;
                        }
                    }
                    email.insert(key, r);
                }
            }
        }
        let mut by_domain: HashMap<String, String> = HashMap::with_capacity(domain_votes.len());
        for (domain, votes) in domain_votes {
            if let Some(area) = majority_area(votes) {
                by_domain.insert(domain, area);
            }
        }
        *self.by_email.write_recover() = email;
        *self.by_id.write_recover() = id;
        *self.by_domain.write_recover() = by_domain;
    }

    /// O(1) email-domain → area. Returns `None` for generic providers,
    /// unknown domains, or blank input.
    pub fn lookup_domain_area(&self, email: &str) -> Option<String> {
        let key = email.trim().to_ascii_lowercase();
        let domain = email_domain(&key)?;
        self.by_domain.read_recover().get(domain).cloned()
    }

    /// O(1) email → PersonRef. Returns `None` for unknown / blank emails.
    pub fn lookup_email(&self, email: &str) -> Option<PersonRef> {
        let key = email.trim().to_ascii_lowercase();
        if key.is_empty() {
            return None;
        }
        self.by_email.read_recover().get(&key).cloned()
    }

    /// O(1) id → PersonRef. Returns `None` for unknown ids (e.g., a
    /// vault-local event still references a person the user deleted).
    pub fn lookup_id(&self, id: &str) -> Option<PersonRef> {
        let key = id.trim();
        if key.is_empty() {
            return None;
        }
        self.by_id.read_recover().get(key).cloned()
    }

    pub fn len(&self) -> usize {
        self.by_id.read_recover().len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.read_recover().is_empty()
    }
}

impl Default for PeopleEmailIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// One row in the events cache. Path is the absolute `events/<id>.md`
/// (or legacy `cadence/<date>.md` for un-migrated inline events) so the
/// DTO builder can compute the vault-relative path without consulting
/// disk.
#[derive(Debug, Clone)]
pub struct CachedEvent {
    pub path: PathBuf,
    pub event: ParsedEvent,
}

/// Date-bucketed cache of parsed vault-local events. Non-recurring events
/// bucket by their start `NaiveDate`; recurring events live in a separate
/// flat list scanned by every query (small N — handful of standups/1:1s).
/// iCal events (provider=Ical) contribute a parsed-event overlay carrying
/// the user's meeting notes plus any local metadata overrides (title /
/// date / duration / etc). Metadata fields in the overlay win over the
/// gcal cache at read time so a local edit survives the next sync.
pub struct EventsCache {
    by_date: RwLock<HashMap<NaiveDate, Vec<CachedEvent>>>,
    recurring: RwLock<Vec<CachedEvent>>,
    /// Per-iCal-occurrence override file contents, keyed by occurrence id
    /// (which is the filename stem of `events/<occurrence_id>.md`).
    /// Stores the full parsed event so the read merge can layer the
    /// user's edits over the gcal cache for any field that differs.
    ical_overlays: RwLock<HashMap<String, ParsedEvent>>,
}

impl EventsCache {
    pub fn new() -> Self {
        EventsCache {
            by_date: RwLock::new(HashMap::new()),
            recurring: RwLock::new(Vec::new()),
            ical_overlays: RwLock::new(HashMap::new()),
        }
    }

    /// Drop every entry — used at the start of a full rebuild.
    pub fn clear(&self) {
        self.by_date.write_recover().clear();
        self.recurring.write_recover().clear();
        self.ical_overlays.write_recover().clear();
    }

    /// Remove any prior record for this path, then re-insert per the event's
    /// provider + recurring rule. Safe to call repeatedly — the upsert is
    /// the canonical mutation point for create/update/external-change.
    pub fn upsert(&self, path: PathBuf, event: ParsedEvent) {
        self.remove_path(&path);
        if event.provider == Some(EventProvider::Ical) {
            // iCal events are projected from the gcal cache. The vault file
            // carries the user's meeting-notes body PLUS any local metadata
            // override they've made (title / date / duration); the read
            // merge in event_ical_get layers it over the cache.
            self.ical_overlays
                .write()
                .unwrap()
                .insert(event.id.clone(), event);
            return;
        }
        if matches!(event.recurring, RecurringRule::None) {
            if let Some(date) = parsed_event_date(&event.date) {
                let entry = CachedEvent { path, event };
                self.by_date
                    .write()
                    .unwrap()
                    .entry(date)
                    .or_default()
                    .push(entry);
            }
        } else {
            self.recurring
                .write()
                .unwrap()
                .push(CachedEvent { path, event });
        }
    }

    /// Drop any record (event or ical-notes) keyed off this path.
    pub fn remove_path(&self, path: &Path) {
        {
            let mut by_date = self.by_date.write_recover();
            for vec in by_date.values_mut() {
                vec.retain(|e| e.path != path);
            }
            by_date.retain(|_, v| !v.is_empty());
        }
        {
            let mut recurring = self.recurring.write_recover();
            recurring.retain(|e| e.path != path);
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            self.ical_overlays.write_recover().remove(stem);
        }
    }

    /// Snapshot of (non-recurring events for `target`, all recurring events).
    /// Caller is responsible for projecting the recurring events through
    /// `occurrence_for`. Returns owned clones so the read locks drop fast.
    pub fn snapshot_for_date(&self, target: NaiveDate) -> (Vec<CachedEvent>, Vec<CachedEvent>) {
        let non_recurring = self
            .by_date
            .read()
            .unwrap()
            .get(&target)
            .cloned()
            .unwrap_or_default();
        let recurring = self.recurring.read_recover().clone();
        (non_recurring, recurring)
    }

    /// Full parsed-event overlay for an iCal event, if a local file exists.
    /// Carries any local metadata overrides (title / date / duration) plus
    /// the user's notes body.
    pub fn ical_overlay(&self, synthetic_id: &str) -> Option<ParsedEvent> {
        self.ical_overlays
            .read()
            .unwrap()
            .get(synthetic_id)
            .cloned()
    }
}

impl Default for EventsCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Domain portion of a (lowercased) email, or `None` when there's no
/// `@` or nothing after it.
fn email_domain(email: &str) -> Option<&str> {
    email
        .rsplit_once('@')
        .map(|(_, domain)| domain)
        .filter(|d| !d.is_empty())
}

/// Trimmed, non-empty area of a person, ready to tally as a vote.
fn person_area(person: &PersonRef) -> Option<String> {
    person
        .area
        .as_ref()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
}

/// Free-mail providers that say nothing about which organization (and
/// therefore which area) an attendee belongs to. Kept out of the
/// domain→area map so a single personal contact at gmail.com doesn't
/// drag every gmail attendee into that contact's area.
fn is_generic_email_domain(domain: &str) -> bool {
    matches!(
        domain,
        "gmail.com"
            | "googlemail.com"
            | "outlook.com"
            | "hotmail.com"
            | "live.com"
            | "msn.com"
            | "yahoo.com"
            | "ymail.com"
            | "icloud.com"
            | "me.com"
            | "mac.com"
            | "aol.com"
            | "proton.me"
            | "protonmail.com"
            | "pm.me"
            | "fastmail.com"
            | "hey.com"
            | "gmx.com"
            | "yandex.com"
    )
}

/// Collapse a domain's per-area vote tally to its single most-common
/// area. Ties break on the lexicographically smaller area id so the
/// result is deterministic regardless of HashMap iteration order.
fn majority_area(votes: HashMap<String, usize>) -> Option<String> {
    votes
        .into_iter()
        .max_by(|(a_area, a_n), (b_area, b_n)| a_n.cmp(b_n).then_with(|| b_area.cmp(a_area)))
        .map(|(area, _)| area)
}

/// Parse an event date string (RFC3339, or naive `YYYY-MM-DDTHH:MM:SS`)
/// down to its `NaiveDate`. Returns `None` for malformed dates, which
/// drops the event out of the cache silently — the events_for_date scan
/// would have done the same.
fn parsed_event_date(s: &str) -> Option<NaiveDate> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.date_naive());
    }
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return Some(naive.date());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_get_roundtrip() {
        let idx = EventIndex::new();
        idx.insert("e_001".to_string(), PathBuf::from("/vault/cadence/foo.md"));
        assert_eq!(
            idx.get("e_001"),
            Some(PathBuf::from("/vault/cadence/foo.md"))
        );
    }

    #[test]
    fn get_missing_returns_none() {
        let idx = EventIndex::new();
        assert_eq!(idx.get("nope"), None);
    }

    #[test]
    fn remove_returns_old_path() {
        let idx = EventIndex::new();
        idx.insert("e_001".to_string(), PathBuf::from("/a/b.md"));
        assert_eq!(idx.remove("e_001"), Some(PathBuf::from("/a/b.md")));
        assert_eq!(idx.get("e_001"), None);
    }
}
