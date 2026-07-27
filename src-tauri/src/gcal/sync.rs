// One sync pass: fetch every configured calendar's iCal URL, parse,
// and store the events in the IcalEventCache (in-memory + JSON on
// disk). The Cadence query merges cached events with vault-local
// markdown events at read time.
//
// Why a cache and not per-event markdown files? See gcal/cache.rs
// header. Short version: a calendar with thousands of events crashes
// the renderer when each event becomes its own atomic-write file.
//
// Error handling is per-account: a 404 on one calendar populates the
// AccountSyncResult.error field for that calendar but doesn't abort
// the others. The top-level SyncReport always Ok-returns from this
// function — the only way it errors is misuse (vault not configured).

use crate::gcal::cache;
use crate::gcal::ical;
use crate::network::{self, PublicFetchOptions};
use crate::AppState;
use crate::{log_error, log_info};
use chrono::Utc;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";
pub const STORE_KEY: &str = "gcal_accounts";
const LOG_TARGET: &str = "gcal::sync";
const KEYCHAIN_SERVICE: &str = "Woodshed Google Calendar";

/// One per-occurrence dismissal: which `(uid, date)` row the user
/// clicked Hide on. Distinct from `GcalAccountMeta.dismissed_uids`
/// (which hides every occurrence of the UID).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct DismissedOccurrence {
    /// VEVENT UID exactly as it appears in the iCal feed.
    pub uid: String,
    /// Projected occurrence date in `YYYY-MM-DD`. Normalized to UTC
    /// when persisted (extracted via `date_part` from the DTO's
    /// RFC3339 date) so comparisons don't drift with the user's
    /// local-time zone.
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GcalAccountMeta {
    pub display_name: String,
    /// Hex color, e.g. "#FF6B6B".
    pub color: String,
    /// Legacy plaintext secret URL, accepted for one-time migration only.
    #[serde(default, skip_serializing)]
    pub url: String,
    #[serde(default)]
    pub url_configured: bool,
    /// Email addresses the user is known by on THIS calendar. The
    /// sync filter keeps an event when the user appears as
    /// `ORGANIZER` or `ATTENDEE` with any of these emails, and drops
    /// events declined under any of them. Multiple addresses because
    /// a single user often has both a personal Gmail and a workspace
    /// alias (e.g. owner@personal.example + owner@work.example).
    /// Empty list ⇒ filtering disabled for this calendar, all parsed
    /// events are kept.
    #[serde(default)]
    pub emails: Vec<String>,
    /// VEVENT UIDs the user has dismissed locally, hiding every
    /// occurrence of the UID. Legacy field — pre-dates the per-
    /// occurrence path below and is kept read-write so dismissals
    /// written by older builds still apply. New dismissals from the
    /// detail page write to `dismissed_occurrences` instead, so
    /// clicking Hide on one row never affects sibling rows.
    /// Filtered at query time (events_for_date, event_ical_get, tag
    /// tables); local-only — the source calendar is untouched.
    #[serde(default)]
    pub dismissed_uids: Vec<String>,
    /// Per-occurrence dismissals — `(uid, YYYY-MM-DD)` pairs. The
    /// row a user clicks Hide on, and only that row, lands here.
    /// Filtered the same way as `dismissed_uids` but matched by both
    /// UID and the projected occurrence date, so a weekly meeting's
    /// other Thursdays keep showing.
    #[serde(default)]
    pub dismissed_occurrences: Vec<DismissedOccurrence>,
    /// RFC 3339 creation timestamp.
    pub created_at: String,
    /// RFC 3339; updated on a successful per-account pass.
    pub last_synced_at: Option<String>,
    /// Most recent sync error for this account, persisted across
    /// restarts. Cleared by a successful sync.
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountSyncResult {
    pub account_id: String,
    /// Events written to the cache this pass.
    pub written: u32,
    /// Always 0 in the cache-based world — the cache is replaced
    /// wholesale so there's no per-event deletion concept. Kept on
    /// the wire shape so the frontend type doesn't need a migration.
    pub deleted: u32,
    /// Non-None when the per-account fetch or parse failed. Other
    /// accounts in the same SyncReport still ran.
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub accounts: Vec<AccountSyncResult>,
}

/// Run a sync over every configured iCal account, or just the one
/// passed in `account_id_filter`. Returns a per-account report; the
/// outer Result only errors when something at the harness level is
/// broken (vault not configured, store unreadable).
pub async fn sync_all(
    app: &AppHandle,
    state: &AppState,
    account_id_filter: Option<&str>,
) -> Result<SyncReport, String> {
    let started = Instant::now();

    let accounts = read_all_accounts(app)?;
    let scope = account_id_filter
        .map(|f| f.to_string())
        .unwrap_or_else(|| "all".to_string());
    log_info!(
        LOG_TARGET,
        "sync_all start (scope={scope}, configured={})",
        accounts.len()
    );
    let mut results: Vec<AccountSyncResult> = Vec::new();

    for account_id in accounts.keys() {
        if let Some(filter) = account_id_filter {
            if account_id != filter {
                continue;
            }
        }
        let per_started = Instant::now();
        log_info!(LOG_TARGET, "sync_one start ({account_id})");
        let result = match sync_one(app, state, account_id).await {
            Ok(written) => {
                log_info!(
                    LOG_TARGET,
                    "sync_one ok ({account_id}, cached={written}, took={}ms)",
                    per_started.elapsed().as_millis()
                );
                AccountSyncResult {
                    account_id: account_id.clone(),
                    written,
                    deleted: 0,
                    error: None,
                }
            }
            Err(e) => {
                log_error!(
                    LOG_TARGET,
                    "sync_one failed ({account_id}, took={}ms): {e}",
                    per_started.elapsed().as_millis()
                );
                AccountSyncResult {
                    account_id: account_id.clone(),
                    written: 0,
                    deleted: 0,
                    error: Some(e),
                }
            }
        };
        let _ = persist_sync_outcome(app, account_id, result.error.as_deref());
        results.push(result);
    }

    log_info!(
        LOG_TARGET,
        "sync_all done (accounts={}, took={}ms)",
        results.len(),
        started.elapsed().as_millis()
    );
    Ok(SyncReport { accounts: results })
}

async fn sync_one(app: &AppHandle, state: &AppState, account_id: &str) -> Result<u32, String> {
    let mut accounts = read_all_accounts(app)?;
    let meta = accounts
        .get(account_id)
        .cloned()
        .ok_or_else(|| format!("unknown calendar account {account_id}"))?;
    let url = if let Some(url) = read_ical_url(account_id) {
        url
    } else if !meta.url.trim().is_empty() {
        let url = meta.url.trim().to_string();
        store_ical_url(account_id, &url)?;
        if let Some(stored) = accounts.get_mut(account_id) {
            stored.url.clear();
            stored.url_configured = true;
        }
        write_all_accounts(app, &accounts)?;
        url
    } else {
        return Err(format!("no iCal URL stored for account {account_id}"));
    };

    log_info!(
        LOG_TARGET,
        "fetch start ({account_id}, url_len={})",
        url.len()
    );
    let response = network::fetch_public(
        &url,
        &PublicFetchOptions {
            max_bytes: 25 * 1024 * 1024,
            max_redirects: 5,
            timeout: Duration::from_secs(30),
            user_agent: "Woodshed/0.1 calendar-sync",
            accept: Some("text/calendar, text/plain;q=0.9"),
            https_only: true,
        },
    )
    .await
    .map_err(|e| format!("calendar fetch failed: {e}"))?;
    let bytes = response.bytes;
    log_info!(LOG_TARGET, "fetch ok ({account_id}, {} bytes)", bytes.len());

    let parsed = ical::parse_feed(&bytes).map_err(|e| format!("parse failed: {e}"))?;
    let parsed_count = parsed.len();
    log_info!(LOG_TARGET, "parsed {parsed_count} events ({account_id})");

    // Two filters, both gated on the per-calendar emails list:
    //   1) DECLINED — events the user said no to. Matches Google's
    //      UI default of hiding declined events.
    //   2) involvement — events where none of the user's addresses
    //      appear as ORGANIZER or ATTENDEE. Drops "calendar viewer"
    //      events from shared/team calendars where the user isn't
    //      personally on the meeting.
    //
    // Per-calendar emails (rather than the global profile email)
    // because users often have separate addresses per workspace: a
    // single workspace iCal feed might list the owner as
    // owner@work.example on company meetings AND as
    // owner@personal.example on personal events that landed on the
    // shared calendar. Empty emails list ⇒ both filters are no-ops.
    let emails = accounts
        .get(account_id)
        .map(|m| m.emails.clone())
        .unwrap_or_default();
    if emails.is_empty() {
        crate::log_warn!(
            LOG_TARGET,
            "no emails configured for {account_id} — filters are no-ops"
        );
    }

    let after_declined: Vec<_> = parsed
        .into_iter()
        .filter(|ev| !ev.user_declined(&emails))
        .collect();
    let declined_dropped = parsed_count - after_declined.len();

    let after_involvement: Vec<_> = after_declined
        .into_iter()
        .filter(|ev| ev.user_involved(&emails))
        .collect();
    let uninvolved_dropped = parsed_count - declined_dropped - after_involvement.len();

    let sync_start_date = chrono::Local::now().date_naive();
    let note_backed_series_ids = configured_vault_path(app)
        .map(|vault| cache::note_backed_ical_series_ids(&vault))
        .unwrap_or_default();
    let after_involvement_count = after_involvement.len();
    let events = cache::retain_events_on_or_after_or_note_backed(
        after_involvement,
        sync_start_date,
        account_id,
        &note_backed_series_ids,
    );
    if events.len() > cache::MAX_CACHED_EVENTS_PER_ACCOUNT {
        return Err(format!(
            "calendar contains more than {} retained events",
            cache::MAX_CACHED_EVENTS_PER_ACCOUNT
        ));
    }
    let past_dropped = after_involvement_count - events.len();
    let kept = events.len() as u32;

    log_info!(
        LOG_TARGET,
        "filter ({account_id}, parsed={parsed_count}, declined={declined_dropped}, uninvolved={uninvolved_dropped}, past={past_dropped}, start={sync_start_date}, kept={kept})"
    );

    // Replace the in-memory cache + persist to disk. This is a single
    // atomic write of one JSON file regardless of event count, vs the
    // old approach of N atomic-writes for N events (which crashed at
    // ~5000 events).
    state.ical_cache.set(account_id.to_string(), events.clone());
    cache::save_to_disk(app, account_id, &events)?;
    log_info!(LOG_TARGET, "cached {kept} events ({account_id})");

    Ok(kept)
}

fn configured_vault_path(app: &AppHandle) -> Option<PathBuf> {
    let store = app.store(STORE_FILE).ok()?;
    store
        .get("vault_path")
        .and_then(|v| v.as_str().map(PathBuf::from))
}

/// Record the outcome of one per-account sync pass to the persistent
/// store. Success path stamps `last_synced_at` and clears any prior
/// error; failure path stamps `last_error` while leaving the previous
/// `last_synced_at` intact so the UI can show both "synced 2h ago"
/// and "last attempt failed with X" simultaneously.
fn persist_sync_outcome(
    app: &AppHandle,
    account_id: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let mut accounts = read_all_accounts(app)?;
    if let Some(meta) = accounts.get_mut(account_id) {
        match error {
            None => {
                meta.last_synced_at = Some(Utc::now().to_rfc3339());
                meta.last_error = None;
            }
            Some(msg) => {
                meta.last_error = Some(msg.to_string());
            }
        }
        write_all_accounts(app, &accounts)?;
    }
    Ok(())
}

pub fn read_all_accounts(app: &AppHandle) -> Result<HashMap<String, GcalAccountMeta>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut accounts: HashMap<String, GcalAccountMeta> = store
        .get(STORE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    accounts.retain(|id, _| {
        let valid = crate::gcal::validate_account_id(id).is_ok();
        if !valid {
            crate::log_warn!(LOG_TARGET, "ignored invalid calendar account id");
        }
        valid
    });
    Ok(accounts)
}

pub fn write_all_accounts(
    app: &AppHandle,
    accounts: &HashMap<String, GcalAccountMeta>,
) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(
        STORE_KEY,
        serde_json::to_value(accounts).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

pub fn store_ical_url(account_id: &str, url: &str) -> Result<(), String> {
    crate::gcal::validate_account_id(account_id)?;
    Entry::new(KEYCHAIN_SERVICE, account_id)
        .map_err(|e| format!("open calendar credential: {e}"))?
        .set_password(url)
        .map_err(|e| format!("store calendar credential: {e}"))
}

pub fn forget_ical_url(account_id: &str) -> Result<(), String> {
    crate::gcal::validate_account_id(account_id)?;
    let entry = Entry::new(KEYCHAIN_SERVICE, account_id)
        .map_err(|e| format!("open calendar credential: {e}"))?;
    match entry.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete calendar credential: {e}")),
    }
}

fn read_ical_url(account_id: &str) -> Option<String> {
    crate::gcal::validate_account_id(account_id).ok()?;
    Entry::new(KEYCHAIN_SERVICE, account_id)
        .ok()?
        .get_password()
        .ok()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
}

#[cfg(test)]
mod credential_metadata_tests {
    use super::*;

    #[test]
    fn calendar_metadata_never_serializes_secret_url() {
        let meta = GcalAccountMeta {
            display_name: "Work".into(),
            color: "#000000".into(),
            url: "https://calendar.example/private?token=secret".into(),
            url_configured: true,
            emails: Vec::new(),
            dismissed_uids: Vec::new(),
            dismissed_occurrences: Vec::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            last_synced_at: None,
            last_error: None,
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(!json.contains("token=secret"));
        assert!(!json.contains("\"url\""));
        assert!(json.contains("urlConfigured"));
    }
}
