// Google Calendar (Phase 2a — iCal subscription, read-only) Tauri commands.
//
// Storage layout:
//   - Non-secret account metadata lives in the Tauri config store.
//     Secret iCal URLs live in the operating-system credential store.
//   - Parsed events for each calendar live in
//     `<app_data_dir>/gcal-cache/<account_id>.json`, replaced wholesale
//     on every sync.
//
// Per-account commands: add / list / update / remove + the sync entry
// point. The frontend `useGcalSync` mutation drives all of them.

use crate::gcal::{cache, sync, validate_account_id};
use crate::network::{self, PublicFetchOptions};
use crate::AppState;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, State};
use ulid::Ulid;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcalAccountInfo {
    pub id: String,
    pub display_name: String,
    pub color: String,
    /// Email addresses the user is known by on this calendar.
    /// Drives the sync's declined / involvement filters; empty list
    /// disables filtering for that calendar.
    pub emails: Vec<String>,
    /// RFC 3339; None when the account has never synced (between Add
    /// and the first sync_one, which happens immediately on add).
    pub last_synced_at: Option<String>,
    /// Most recent sync error. Cleared by a successful sync; persists
    /// across app restarts so settings keeps surfacing it.
    pub last_error: Option<String>,
    /// Count of UIDs the user has dismissed locally on this calendar.
    pub dismissed_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcalAccountAddInput {
    pub url: String,
    pub display_name: String,
    pub color: String,
    /// Optional. Frontend collects this as a comma-separated string
    /// and splits before sending. Empty list = filtering disabled
    /// (user sees every event the feed contains).
    #[serde(default)]
    pub emails: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcalAccountUpdateInput {
    pub account_id: String,
    pub display_name: Option<String>,
    pub color: Option<String>,
    pub emails: Option<Vec<String>>,
}

#[tauri::command]
pub async fn gcal_account_add(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GcalAccountAddInput,
) -> Result<GcalAccountInfo, String> {
    let url = input.url.trim().to_string();
    let display_name = input.display_name.trim().to_string();
    let color = input.color.trim().to_string();
    if url.is_empty() {
        return Err("iCal URL is required".into());
    }
    network::validate_public_http_url(&url, true)?;

    // Validate the feed before persisting anything. A 4xx/5xx or a
    // body that doesn't parse means the user pasted the wrong URL —
    // better to fail loudly here than silently store something useless.
    let response = network::fetch_public(
        &url,
        &PublicFetchOptions {
            max_bytes: 25 * 1024 * 1024,
            max_redirects: 5,
            timeout: Duration::from_secs(30),
            user_agent: "Woodshed/0.1 calendar-connect",
            accept: Some("text/calendar, text/plain;q=0.9"),
            https_only: true,
        },
    )
    .await
    .map_err(|e| format!("calendar fetch failed: {e}"))?;
    let bytes = response.bytes;
    crate::gcal::ical::parse_feed(&bytes).map_err(|e| format!("parse failed: {e}"))?;

    let account_id = format!("gcal_{}", Ulid::new());
    sync::store_ical_url(&account_id, &url)?;

    let emails = clean_emails(input.emails);
    let meta = sync::GcalAccountMeta {
        display_name: display_name.clone(),
        color: color.clone(),
        url: String::new(),
        url_configured: true,
        emails,
        dismissed_uids: Vec::new(),
        dismissed_occurrences: Vec::new(),
        created_at: Utc::now().to_rfc3339(),
        last_synced_at: None,
        last_error: None,
        fetch_content_hash: None,
        fetch_derivation_hash: None,
    };
    let mut accounts = sync::read_all_accounts(&app)?;
    accounts.insert(account_id.clone(), meta);
    sync::write_all_accounts(&app, &accounts)?;

    // Trigger an immediate sync for this account so the very next
    // render of /cadence/[date] already has events.
    let _ = sync::sync_all(&app, &state, Some(&account_id)).await?;

    let accounts = sync::read_all_accounts(&app)?;
    let meta = accounts
        .get(&account_id)
        .ok_or_else(|| "account vanished after add".to_string())?;
    Ok(GcalAccountInfo {
        id: account_id,
        display_name: meta.display_name.clone(),
        color: meta.color.clone(),
        emails: meta.emails.clone(),
        last_synced_at: meta.last_synced_at.clone(),
        last_error: meta.last_error.clone(),
        dismissed_count: meta.dismissed_uids.len(),
    })
}

#[tauri::command]
pub async fn gcal_accounts_list(app: AppHandle) -> Result<Vec<GcalAccountInfo>, String> {
    let accounts = sync::read_all_accounts(&app)?;
    let mut out: Vec<GcalAccountInfo> = accounts
        .into_iter()
        .map(|(id, meta)| GcalAccountInfo {
            id,
            display_name: meta.display_name,
            color: meta.color,
            emails: meta.emails,
            last_synced_at: meta.last_synced_at,
            last_error: meta.last_error,
            dismissed_count: meta.dismissed_uids.len(),
        })
        .collect();
    // Stable display order: by display name, case-insensitive.
    out.sort_by(|a, b| {
        a.display_name
            .to_ascii_lowercase()
            .cmp(&b.display_name.to_ascii_lowercase())
    });
    Ok(out)
}

#[tauri::command]
pub async fn gcal_account_update(
    app: AppHandle,
    input: GcalAccountUpdateInput,
) -> Result<GcalAccountInfo, String> {
    let account_id = input.account_id.trim().to_string();
    validate_account_id(&account_id)?;
    let mut accounts = sync::read_all_accounts(&app)?;
    let meta = accounts
        .get_mut(&account_id)
        .ok_or_else(|| format!("unknown account {account_id}"))?;
    if let Some(name) = input.display_name {
        meta.display_name = name.trim().to_string();
    }
    if let Some(color) = input.color {
        meta.color = color.trim().to_string();
    }
    if let Some(emails) = input.emails {
        meta.emails = clean_emails(emails);
    }
    let info = GcalAccountInfo {
        id: account_id,
        display_name: meta.display_name.clone(),
        color: meta.color.clone(),
        emails: meta.emails.clone(),
        last_synced_at: meta.last_synced_at.clone(),
        last_error: meta.last_error.clone(),
        dismissed_count: meta.dismissed_uids.len(),
    };
    sync::write_all_accounts(&app, &accounts)?;
    Ok(info)
}

/// Normalize a user-supplied email list: trim each entry, drop blanks,
/// lowercase for case-insensitive matching downstream.
fn clean_emails(raw: Vec<String>) -> Vec<String> {
    raw.into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

#[tauri::command]
pub async fn gcal_account_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    let account_id = account_id.trim().to_string();
    validate_account_id(&account_id)?;

    let mut accounts = sync::read_all_accounts(&app)?;
    if !accounts.contains_key(&account_id) {
        return Err(format!("unknown account {account_id}"));
    }

    // Drop the in-memory and on-disk cache for this calendar first.
    // Best-effort: even if any of the steps fail, the user can re-add
    // and re-sync to recover.
    state.ical_cache.remove(&account_id);
    let _ = cache::delete_from_disk(&app, &account_id);
    sync::forget_ical_url(&account_id)?;

    accounts.remove(&account_id);
    sync::write_all_accounts(&app, &accounts)?;

    Ok(())
}

#[tauri::command]
pub async fn gcal_ical_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    account_id: Option<String>,
) -> Result<sync::SyncReport, String> {
    let account_id = account_id.map(|id| id.trim().to_string());
    if let Some(id) = account_id.as_deref() {
        validate_account_id(id)?;
    }
    sync::sync_all(&app, &state, account_id.as_deref()).await
}

/// Dismiss a single occurrence of an iCal event locally. The
/// `(uid, occurrenceDate)` pair is appended to the owning account's
/// `dismissed_occurrences` list and survives sync (the cache is
/// replaced wholesale on every sync, but account meta is not). Other
/// occurrences of the same recurring master keep showing — only the
/// row the user clicked is hidden. The notes attachment at
/// `events/<synthetic_id>.md`, if any, is left in place so hiding an
/// occurrence never deletes the user's notes.
#[tauri::command]
pub fn event_ical_dismiss(
    app: AppHandle,
    account_id: String,
    external_id: String,
    occurrence_date: String,
) -> Result<(), String> {
    let account_id = account_id.trim().to_string();
    let external_id = external_id.trim().to_string();
    let date = normalize_occurrence_date(&occurrence_date)?;
    validate_account_id(&account_id)?;
    if external_id.is_empty() || external_id.len() > 2_048 {
        return Err("externalId must be between 1 and 2048 bytes".into());
    }
    let mut accounts = sync::read_all_accounts(&app)?;
    let meta = accounts
        .get_mut(&account_id)
        .ok_or_else(|| format!("unknown account {account_id}"))?;
    let exists = meta
        .dismissed_occurrences
        .iter()
        .any(|d| d.uid == external_id && d.date == date);
    if !exists {
        if meta.dismissed_occurrences.len() >= 100_000 {
            return Err("calendar dismissal limit reached".into());
        }
        meta.dismissed_occurrences.push(sync::DismissedOccurrence {
            uid: external_id,
            date,
        });
    }
    sync::write_all_accounts(&app, &accounts)?;
    Ok(())
}

/// Accept either a bare `YYYY-MM-DD` or an RFC 3339 datetime; return
/// the date portion as `YYYY-MM-DD`. Rejects anything else so a
/// frontend bug can't silently store malformed dismissal keys.
fn normalize_occurrence_date(s: &str) -> Result<String, String> {
    let s = s.trim();
    if s.len() >= 10 {
        let date = &s[..10];
        if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok() {
            return Ok(date.to_string());
        }
    }
    Err(format!(
        "invalid occurrenceDate {s:?} — expected YYYY-MM-DD"
    ))
}
