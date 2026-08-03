// Gmail Tauri commands. Phase 1: read-only, single-account, on-demand pull.
//
// Persistence goes through `commands::mail::persist_inbox_email` so Gmail
// messages land on disk in the canonical EmailSummary shape. The `inbox`
// field is `gmail:<email>`, which the list/aggregation UI keys off of.
//
// All IMAP work is sync (`imap` 2.4 has no async API) — wrap every call
// in `tokio::task::spawn_blocking` from these async commands so the
// Tokio runtime isn't pinned by a blocking socket read.

use crate::commands::mail::{
    build_email_summary, mail_get_local_inner, persist_inbox_email, persist_sent_email,
    sanitize_attachment_filename, save_attachment_bytes, strip_brackets, vault_root, Attachment,
    EmailSummary,
};
use crate::credentials::{CredentialBroker, CredentialId};
use crate::gmail::{creds, imap_client, parse, smtp_client, CredsError};
use crate::AppState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

/// Tauri store file (shared with config — same single source for all
/// app-level metadata). Gmail account metadata (display name, created-at)
/// lives under the `gmail_accounts` key keyed by email. Secrets stay behind
/// `CredentialBroker`.
const STORE_FILE: &str = "config.json";
const STORE_KEY: &str = "gmail_accounts";
const MAX_OUTGOING_ATTACHMENT_COUNT: usize = 10;
const MAX_OUTGOING_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_OUTGOING_ATTACHMENTS_TOTAL_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GmailAccountMeta {
    /// Label shown in the inbox dropdown / settings list. Identifies the
    /// account inside Woodshed; never leaves the device.
    display_name: String,
    /// Human-readable "From:" name on outgoing mail. The recipient sees
    /// `"<sender_name>" <email>` when this is set; bare `<email>` when
    /// it isn't. Independent of `display_name` so a user can have
    /// multiple accounts that all sign as "Alex Example" while the
    /// Woodshed labels stay distinct ("Personal", "Work", etc.).
    #[serde(default)]
    sender_name: String,
    /// RFC 3339.
    created_at: String,
    /// Older builds wrote the secret here. Deserialize it once for
    /// migration, but never serialize it back to config.json.
    #[serde(default, skip_serializing)]
    app_password: String,
    #[serde(default)]
    credential_configured: bool,
}

/// Stable per-account inbox id used in EmailSummary.inbox. Keying on the
/// email address keeps the data model simple — no separate ULID layer
/// needed; the email itself is the stable account ID.
fn inbox_id(email: &str) -> String {
    format!("gmail:{email}")
}

/// Reverse of `inbox_id` — pull the email address out of a `gmail:<email>`
/// inbox id. Returns None for any other shape.
pub fn email_from_inbox_id(inbox: &str) -> Option<&str> {
    inbox.strip_prefix("gmail:")
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailAccountInfo {
    pub email: String,
    pub inbox: String,
    pub display_name: String,
    /// Empty string when no sender name is configured (we'll send as
    /// bare `<email>`). Frontend can show a placeholder in that case.
    pub sender_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailAccountSetInput {
    pub email: String,
    pub app_password: String,
    /// User-supplied label shown in the inbox dropdown. Falls back to
    /// the email address when omitted.
    #[serde(default)]
    pub display_name: Option<String>,
    /// "From:" name on outgoing mail. None means "send as bare email
    /// (no display name)" — recipients see just `<email>`.
    #[serde(default)]
    pub sender_name: Option<String>,
}

/// Mirrors the `InboxDto` shape from commands/mail.rs so the frontend
/// can render Gmail "inboxes" through the existing inbox dropdown
/// without any per-provider branching.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailInboxDto {
    pub inbox_id: String,
    pub email: String,
    pub display_name: Option<String>,
    /// RFC 3339.
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailSyncResult {
    /// Inbox message IDs persisted during this refresh, including re-fetches.
    pub written: Vec<String>,
    /// Messages that did not already exist anywhere in the local mail store.
    /// This excludes ordinary re-fetches and drives batched new-mail notices.
    pub new_messages: usize,
    /// Total messages pulled in this round trip (might exceed `written`
    /// once we add dedupe — for v1 we always re-write).
    pub fetched: usize,
    /// Local inbox messages archived during reconciliation — they left the
    /// Gmail inbox (archived/handled directly in Gmail) so we dropped them
    /// from the local inbox too. Surfaced in the refresh log.
    pub removed: usize,
    pub duration_ms: u64,
    /// Account whose inbox we synced. Returned so the frontend can show
    /// "Synced owner@example.com — 12 new" without an extra round trip.
    pub email: String,
}

// ─── Credential commands ────────────────────────────────────────────────────

/// Add (or update) a Gmail account: persist the App Password to the private
/// app-data credential store, keep non-secret metadata in the Tauri store, and
/// prime the in-memory cache.
#[tauri::command]
pub async fn gmail_account_set(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GmailAccountSetInput,
) -> Result<GmailAccountInfo, String> {
    let email = input.email.trim().to_string();
    let app_password = input.app_password.trim().to_string();
    let display_name = input
        .display_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| email.clone());
    if email.is_empty() || app_password.is_empty() {
        return Err("email and app password are required".into());
    }
    let prior = read_account_meta(&app, &email)?;
    let created_at = prior
        .as_ref()
        .filter(|m| !m.created_at.is_empty())
        .map(|m| m.created_at.clone())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let sender_name = input
        .sender_name
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let broker = CredentialBroker::for_app(&app)?;
    broker.save(&CredentialId::gmail(&email), &app_password)?;
    write_account_meta(
        &app,
        &email,
        GmailAccountMeta {
            display_name: display_name.clone(),
            sender_name: sender_name.clone(),
            created_at,
            app_password: String::new(),
            credential_configured: true,
        },
    )?;
    state.gmail_creds.set(creds::Credentials {
        email: email.clone(),
        app_password,
    });
    Ok(GmailAccountInfo {
        inbox: inbox_id(&email),
        email,
        display_name,
        sender_name,
    })
}

/// List every Gmail account the user has configured: union of the
/// Tauri-store `gmail_accounts` map and the env-vars-based account
/// (so a user with creds only in `.env.local` still sees their account
/// in the UI). Display name comes from the store; falls back to the
/// email itself for accounts that exist only via env vars.
#[tauri::command]
pub async fn gmail_accounts_list(app: AppHandle) -> Result<Vec<GmailAccountInfo>, String> {
    let store_accounts = read_all_accounts_from_app(&app)?;
    let mut out: Vec<GmailAccountInfo> = store_accounts
        .iter()
        .map(|(email, meta)| GmailAccountInfo {
            inbox: inbox_id(email),
            email: email.clone(),
            display_name: if meta.display_name.is_empty() {
                email.clone()
            } else {
                meta.display_name.clone()
            },
            sender_name: meta.sender_name.clone(),
        })
        .collect();

    // Merge in the env-vars account if it isn't already represented.
    if let Some(env_email) = creds::env_account_email() {
        let already_present = out.iter().any(|a| a.email.eq_ignore_ascii_case(&env_email));
        if !already_present {
            out.push(GmailAccountInfo {
                inbox: inbox_id(&env_email),
                email: env_email.clone(),
                display_name: env_email,
                sender_name: String::new(),
            });
        }
    }

    // Stable display order: by display name, case-insensitive.
    out.sort_by(|a, b| {
        a.display_name
            .to_ascii_lowercase()
            .cmp(&b.display_name.to_ascii_lowercase())
    });
    Ok(out)
}

/// Update a Gmail account's metadata by email. Both `display_name` and
/// `sender_name` are independently optional — `None` leaves the
/// existing value alone, an empty string clears it, a non-empty string
/// sets it. The brokered App Password is untouched.
#[tauri::command]
pub async fn gmail_account_update(
    app: AppHandle,
    email: String,
    display_name: Option<String>,
    sender_name: Option<String>,
) -> Result<GmailAccountInfo, String> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err("email is required".into());
    }
    let prior = read_account_meta(&app, &email)?;
    let created_at = prior
        .as_ref()
        .filter(|m| !m.created_at.is_empty())
        .map(|m| m.created_at.clone())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    // Display name: never store empty (falls back to email at render
    // time anyway); on explicit empty input, reset to the email.
    let new_display_name = match display_name {
        Some(s) => {
            let t = s.trim().to_string();
            if t.is_empty() {
                email.clone()
            } else {
                t
            }
        }
        None => prior
            .as_ref()
            .map(|m| m.display_name.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| email.clone()),
    };
    // Sender name: empty IS a valid value (means "send as bare email").
    let new_sender_name = match sender_name {
        Some(s) => s.trim().to_string(),
        None => prior
            .as_ref()
            .map(|m| m.sender_name.clone())
            .unwrap_or_default(),
    };
    let credential_configured = prior
        .as_ref()
        .is_some_and(|m| m.credential_configured || !m.app_password.is_empty());
    write_account_meta(
        &app,
        &email,
        GmailAccountMeta {
            display_name: new_display_name.clone(),
            sender_name: new_sender_name.clone(),
            created_at,
            app_password: String::new(),
            credential_configured,
        },
    )?;
    Ok(GmailAccountInfo {
        inbox: inbox_id(&email),
        email,
        display_name: new_display_name,
        sender_name: new_sender_name,
    })
}

/// Remove a Gmail account by email. Drops the local secret, any legacy
/// keychain secret, the
/// Tauri-store metadata, the live IMAP session, and the cached creds.
/// Idempotent — succeeds even when the account isn't configured.
#[tauri::command]
pub async fn gmail_account_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
) -> Result<(), String> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err("email is required".into());
    }
    let broker = CredentialBroker::for_app(&app)?;
    broker.forget(&CredentialId::gmail(&email))?;
    if let Err(error) = creds::forget_legacy_keychain(&email) {
        eprintln!("forget legacy Gmail keychain entry for {email}: {error}");
    }
    state.gmail_creds.invalidate(&email);
    let _ = clear_account_meta(&app, &email);
    let pool = state.gmail_pool.clone();
    let email_clone = email.clone();
    let _ = tokio::task::spawn_blocking(move || pool.forget(&email_clone)).await;
    Ok(())
}

/// Inbox-shape DTOs for every Gmail account, used by the inbox-filter
/// dropdown on the Mail surface.
#[tauri::command]
pub async fn gmail_inboxes_list(app: AppHandle) -> Result<Vec<GmailInboxDto>, String> {
    let store_accounts = read_all_accounts_from_app(&app)?;
    let mut out: Vec<GmailInboxDto> = store_accounts
        .iter()
        .map(|(email, meta)| GmailInboxDto {
            inbox_id: inbox_id(email),
            email: email.clone(),
            display_name: if meta.display_name.is_empty() {
                None
            } else {
                Some(meta.display_name.clone())
            },
            created_at: if meta.created_at.is_empty() {
                chrono::Utc::now().to_rfc3339()
            } else {
                meta.created_at.clone()
            },
        })
        .collect();

    if let Some(env_email) = creds::env_account_email() {
        let already_present = out.iter().any(|i| i.email.eq_ignore_ascii_case(&env_email));
        if !already_present {
            out.push(GmailInboxDto {
                inbox_id: inbox_id(&env_email),
                email: env_email,
                display_name: None,
                created_at: chrono::Utc::now().to_rfc3339(),
            });
        }
    }
    Ok(out)
}

// ─── Sync command ───────────────────────────────────────────────────────────

/// Pull the most recent `limit` messages from one Gmail account and
/// persist each as `inbox/<slug>-<short-id>.md`. Multi-account fan-out
/// happens at the JS layer (`mailSyncRecentMulti`), which calls this
/// once per account from the accounts list.
#[tauri::command]
pub async fn gmail_sync_recent(
    app: AppHandle,
    state: State<'_, AppState>,
    account_email: String,
    limit: Option<u32>,
) -> Result<GmailSyncResult, String> {
    let started = Instant::now();
    let limit = limit.unwrap_or(20).clamp(1, 200) as usize;

    let credentials = resolve_credentials(&app, &state, &account_email)?;
    let email = credentials.email.clone();

    let inbox = inbox_id(&email);
    let vault = vault_root(&app)?;
    // Filename cleanup and the orphaned-sibling sweep are cosmetic and
    // potentially O(n), so run them only on an explicit sync rather than
    // every paginated inbox read.
    let _ = crate::commands::mail::migrate_legacy_filenames(&vault, &state);
    crate::commands::mail::trash_orphaned_html_siblings(&vault, &state);

    // The imap crate is sync. Run every fetch on a blocking thread so we
    // don't park a Tokio worker. The pool keeps the IMAP socket alive
    // across calls so subsequent syncs skip the TLS+LOGIN handshake.
    let snapshot_epoch = state.mail_mutation_epoch.load(Ordering::Acquire);

    // Take the full-inbox ENVELOPE pass first. It is required for
    // reconciliation either way, and taking it up front lets the backfill
    // repair stranded records *before* this batch derives thread ids from
    // them — otherwise fresh mail would be grouped against identities we're
    // about to rewrite. A failure here is non-fatal: sync still pulls mail,
    // it just skips the backfill and the reconcile below.
    let snapshot = {
        let pool = state.gmail_pool.clone();
        let creds = credentials.clone();
        match tokio::task::spawn_blocking(move || imap_client::fetch_inbox_snapshot(&pool, &creds))
            .await
            .map_err(|e| format!("inbox snapshot thread panicked: {e}"))
            .and_then(|result| result.map_err(|e| e.to_string()))
        {
            Ok(snapshot) => Some(snapshot),
            Err(e) => {
                eprintln!("gmail: inbox snapshot failed for {email}: {e}");
                None
            }
        }
    };

    if let Some(snapshot) = snapshot.as_ref() {
        backfill_stranded_identities(
            &app,
            &state,
            &vault,
            &email,
            &inbox,
            snapshot,
            snapshot_epoch,
        );
    }

    let batch = {
        let pool = state.gmail_pool.clone();
        let creds = credentials.clone();
        tokio::task::spawn_blocking(move || imap_client::fetch_recent(&pool, &creds, limit))
            .await
            .map_err(|join_err| format!("gmail sync thread panicked: {join_err}"))?
            .map_err(imap_err_to_string)?
    };

    let mut written = Vec::with_capacity(batch.messages.len());
    let mut new_messages = 0;
    let fetched = batch.messages.len();

    // Gmail's conversation id is unavailable, so subject-based grouping fills
    // the gap for messages with no reply headers. Seed from what's already on
    // disk for this account so a burst spanning two syncs still converges.
    let mut conversations = ConversationThreads::default();
    conversations.seed(&account_inbox_records(&vault, &inbox));

    for raw in &batch.messages {
        let parsed = parse::parse(raw);

        // IMAP UID is only meaningful together with account + UIDVALIDITY.
        // Persist all three so later archive/read mutations address exactly
        // one remote message and cannot collide across Gmail accounts.
        let canonical_uid = imap_client::canonical_uid_id(&email, batch.uid_validity, raw.uid);
        let legacy_uid = format!("gmail-uid-{}", raw.uid);
        // Local identity is always account + UIDVALIDITY + UID. RFC Message-ID
        // and X-GM-MSGID are not account-scoped: the same delivered message can
        // legitimately exist in two configured inboxes.
        let id = canonical_uid.clone();
        let wire_message_id = parsed.message_id.clone();
        let proposed_thread_id = thread_id_for_parsed(&email, &id, &parsed);
        // Only messages with no reply headers need subject grouping. A real
        // References chain is authoritative and must never be overridden by a
        // subject match.
        let thread_id = if parsed.gm_thrid != 0 || parsed.thread_root_message_id.is_some() {
            proposed_thread_id
        } else {
            conversations.resolve(
                &parsed.from_email,
                &parsed.subject,
                &parsed.date,
                proposed_thread_id,
            )
        };

        // Read state mirrors the IMAP \Seen flag. We translate to the
        // existing Woodshed convention: `read` label means seen,
        // `unread` means not. Other labels (inbox, etc.) come along for
        // future filtering.
        let read_label = if parsed.seen { "read" } else { "unread" };
        let labels = vec!["inbox".to_string(), read_label.to_string()];

        // Eager attachment extract — we already have the RFC822 bytes
        // from IMAP, so writing to `attachments/mail/<id>/` here avoids
        // a re-IMAP roundtrip on click. A failure to write any one
        // attachment is logged and skipped; the email itself still lands.
        let attachments = save_parsed_attachments(&state, &vault, &id, &parsed);
        let summary = build_summary_from_parsed(
            id.clone(),
            wire_message_id,
            thread_id,
            inbox.clone(),
            &parsed,
            labels,
            attachments,
        );
        let mut superseded = vec![legacy_uid.clone()];
        if parsed.gm_msgid != 0 {
            superseded.push(format!("gmail-{:x}", parsed.gm_msgid));
        }
        if !parsed.message_id.is_empty() {
            superseded.push(parsed.message_id.clone());
        }
        let is_new = std::iter::once(id.as_str())
            .chain(superseded.iter().map(String::as_str))
            .all(|candidate| {
                crate::commands::mail::find_email_path_anywhere(&vault, candidate).is_none()
            });

        match persist_inbox_email(&app, &state, &summary, snapshot_epoch) {
            Ok(Some(_)) => {
                for obsolete_id in superseded {
                    crate::commands::mail::trash_superseded_email_identity(
                        &app,
                        &state,
                        &vault,
                        &obsolete_id,
                        &inbox,
                    );
                }
                if is_new {
                    new_messages += 1;
                }
                written.push(id)
            }
            Ok(None) => {}
            Err(e) => eprintln!("gmail: failed to persist {id}: {e}"),
        }
    }

    // Reconcile: archive locally anything the user already handled in
    // Gmail (no longer in the Gmail inbox). Skipped when the snapshot fetch
    // above failed — a reconcile failure shouldn't fail the sync that just
    // pulled fresh mail, and an absent id set must never be read as "the
    // Gmail inbox is empty, archive everything local".
    let removed = match snapshot.as_ref() {
        Some(snapshot) => crate::commands::mail::reconcile_gmail_inbox(
            &app,
            &state,
            &vault,
            &inbox,
            &snapshot.ids,
            &written,
        ),
        None => 0,
    };

    // Pull the provider's recent Sent mailbox as part of the same refresh.
    // This is what makes replies sent from Gmail, Apple Mail, or another
    // client appear in Woodshed's local conversation view. Sent sync is
    // additive and never participates in INBOX reconciliation.
    let sent_batch = {
        let pool = state.gmail_pool.clone();
        let creds = credentials.clone();
        match tokio::task::spawn_blocking(move || {
            imap_client::fetch_recent_sent(&pool, &creds, limit)
        })
        .await
        {
            Ok(Ok(batch)) => batch,
            Ok(Err(_)) => {
                eprintln!("gmail: sent mailbox refresh failed");
                None
            }
            Err(_) => {
                eprintln!("gmail: sent mailbox refresh worker failed");
                None
            }
        }
    };

    if let Some(sent_batch) = sent_batch {
        for raw in &sent_batch.messages {
            let parsed = parse::parse(raw);
            let id = if parsed.message_id.is_empty() {
                format!(
                    "gmail-sent-{}-{}-{}",
                    imap_client::account_fingerprint(&email),
                    sent_batch.uid_validity,
                    raw.uid
                )
            } else {
                parsed.message_id.clone()
            };
            let existing = mail_get_local_inner(&vault, &id).ok().flatten();
            let thread_id = sent_thread_id_for_parsed(&email, &id, &parsed, existing.as_ref());

            let attachments = save_parsed_attachments(&state, &vault, &id, &parsed);
            let summary = build_summary_from_parsed(
                id,
                parsed.message_id.clone(),
                thread_id,
                inbox.clone(),
                &parsed,
                vec!["sent".to_string(), "read".to_string()],
                attachments,
            );
            if persist_sent_email(&app, &state, &summary).is_err() {
                eprintln!("gmail: failed to persist one sent message");
            }
        }
    }

    Ok(GmailSyncResult {
        written,
        new_messages,
        fetched,
        removed,
        duration_ms: started.elapsed().as_millis() as u64,
        email,
    })
}

// ─── Send / Reply ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailComposeInput {
    /// Account inbox id (`gmail:<email>`) to send from. Required in the
    /// multi-account world — there is no "active" Gmail account anymore;
    /// the caller has to be explicit about which one.
    pub from_inbox: String,
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<GmailOutgoingAttachment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailOutgoingAttachment {
    pub filename: String,
    pub content_type: String,
    pub data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailReplyInput {
    /// Canonical id of the message being replied to. Used to look up the
    /// original on disk and pull its `Message-ID:`, `From:`, and existing
    /// `References:` chain so threading stays intact.
    pub in_reply_to_message_id: String,
    /// Caller-supplied thread id. Currently advisory — Gmail threads on
    /// References, not on the field name. Kept for API parity with
    /// `mail_reply` so the frontend can stay provider-agnostic.
    #[serde(default)]
    pub thread_id: Option<String>,
    /// Override recipients. Default: sender of the message being replied to.
    #[serde(default)]
    pub to: Option<Vec<String>>,
    #[serde(default)]
    pub cc: Vec<String>,
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<GmailOutgoingAttachment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailSendResult {
    /// Generated RFC 5322 Message-ID (without angle brackets) — same
    /// value used as the on-disk filename id.
    pub message_id: String,
    /// Thread id from the source message (for replies) or the new
    /// message-id (for new compose). Frontend uses this to redirect the
    /// user to the thread view post-send.
    pub thread_id: String,
    /// RFC 3339 send timestamp.
    pub sent_at: String,
}

/// Send a new Gmail message via SMTP. Persists a copy to `sent/`. The
/// caller specifies which account to send from via `from_inbox`
/// (`gmail:<email>` shape).
#[tauri::command]
pub async fn gmail_send(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GmailComposeInput,
) -> Result<GmailSendResult, String> {
    let from_email = email_from_inbox_id(&input.from_inbox).ok_or_else(|| {
        format!(
            "fromInbox {:?} isn't a Gmail inbox id (expected `gmail:<email>`)",
            input.from_inbox
        )
    })?;
    let credentials = resolve_credentials(&app, &state, from_email)?;
    let active_inbox = inbox_id(&credentials.email);
    let meta = read_account_meta(&app, &credentials.email)?;
    // sender_name is the "From:" name on the wire. Use it if set;
    // otherwise fall back to the display_name (legacy behavior); if
    // neither is set, send as bare email (no display-name in From).
    let sender_name = meta
        .as_ref()
        .map(|m| m.sender_name.clone())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            meta.as_ref()
                .map(|m| m.display_name.clone())
                .filter(|s| !s.trim().is_empty() && s != &credentials.email)
        });
    // The "from" we stash in the persisted record reflects what the
    // recipient saw — same string we just put on the wire.
    let persisted_from = sender_name
        .clone()
        .unwrap_or_else(|| credentials.email.clone());
    let vault = vault_root(&app)?;
    let attachments = decode_outgoing_attachments(input.attachments.clone())?;

    let outbound = smtp_client::OutboundMessage {
        from_email: credentials.email.clone(),
        from_display: sender_name,
        to: input.to.clone(),
        cc: input.cc.clone(),
        bcc: input.bcc.clone(),
        subject: input.subject.clone(),
        body: input.body.clone(),
        attachments,
        in_reply_to: None,
        references: Vec::new(),
    };
    let outcome = smtp_client::send(&credentials, &outbound)
        .await
        .map_err(|e| smtp_err_to_string(e, &credentials.email))?;
    let persisted_attachments =
        persist_outgoing_attachments(&state, &vault, &outcome.message_id, &outbound.attachments);

    let mut summary = build_email_summary(
        outcome.message_id.clone(),
        outcome.message_id.clone(),
        account_scoped_thread_id(&credentials.email, &outcome.message_id),
        active_inbox.clone(),
        persisted_from,
        credentials.email.clone(),
        input.subject,
        input.body,
        None,
        outcome.sent_at.clone(),
        vec!["sent".into()],
        persisted_attachments,
    );
    summary.to = input.to;
    summary.cc = input.cc;
    persist_sent_email(&app, &state, &summary)?;

    Ok(GmailSendResult {
        message_id: outcome.message_id.clone(),
        thread_id: outcome.message_id,
        sent_at: outcome.sent_at,
    })
}

/// Reply to a message that's already in the local vault. We read the
/// original to extract its `Message-ID`, `From:`, and any existing
/// `References:` chain, then send a new message with proper threading
/// headers so Gmail groups the reply into the same conversation.
#[tauri::command]
pub async fn gmail_reply(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GmailReplyInput,
) -> Result<GmailSendResult, String> {
    let vault = vault_root(&app)?;
    let original =
        mail_get_local_inner(&vault, &input.in_reply_to_message_id)?.ok_or_else(|| {
            format!(
                "cannot find original message {} in vault — did it get archived?",
                input.in_reply_to_message_id
            )
        })?;

    // The reply goes from the same account the original message arrived
    // on. Extract the email from `gmail:<email>` and look up creds.
    let from_email = email_from_inbox_id(&original.inbox).ok_or_else(|| {
        format!(
            "original message inbox {:?} isn't a Gmail inbox; cannot reply",
            original.inbox
        )
    })?;
    let credentials = resolve_credentials(&app, &state, from_email)?;
    let active_inbox = inbox_id(&credentials.email);
    let meta = read_account_meta(&app, &credentials.email)?;
    let sender_name = meta
        .as_ref()
        .map(|m| m.sender_name.clone())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            meta.as_ref()
                .map(|m| m.display_name.clone())
                .filter(|s| !s.trim().is_empty() && s != &credentials.email)
        });
    let persisted_from = sender_name
        .clone()
        .unwrap_or_else(|| credentials.email.clone());

    // Default reply recipients to the original sender.
    let to = match input.to {
        Some(explicit) => explicit,
        None if !original.from_email.is_empty() => vec![original.from_email.clone()],
        None => Vec::new(),
    };
    let cc = input.cc;
    let attachments = decode_outgoing_attachments(input.attachments)?;

    // Subject: prefix with "Re: " unless one's already there.
    let subject = if original.subject.to_lowercase().starts_with("re:") {
        original.subject.clone()
    } else if original.subject.is_empty() {
        "Re:".to_string()
    } else {
        format!("Re: {}", original.subject)
    };

    let outbound = smtp_client::OutboundMessage {
        from_email: credentials.email.clone(),
        from_display: sender_name,
        to: to.clone(),
        cc: cc.clone(),
        bcc: Vec::new(),
        subject: subject.clone(),
        body: input.body.clone(),
        attachments,
        in_reply_to: Some(wire_message_id(&original).to_string()),
        // We don't currently persist the original References chain in
        // frontmatter — pass just the original message-id, which is the
        // minimum viable thread linkage. Gmail threads on subject + this
        // header anyway; full chain preservation is a follow-up.
        references: vec![wire_message_id(&original).to_string()],
    };
    let outcome = smtp_client::send(&credentials, &outbound)
        .await
        .map_err(|e| smtp_err_to_string(e, &credentials.email))?;
    let persisted_attachments =
        persist_outgoing_attachments(&state, &vault, &outcome.message_id, &outbound.attachments);

    let inherited_thread_id = input
        .thread_id
        .unwrap_or_else(|| original.thread_id.clone());
    let thread_id = account_scoped_thread_id(&credentials.email, &inherited_thread_id);

    let mut summary = build_email_summary(
        outcome.message_id.clone(),
        outcome.message_id.clone(),
        thread_id.clone(),
        active_inbox,
        persisted_from,
        credentials.email.clone(),
        subject,
        input.body,
        None,
        outcome.sent_at.clone(),
        vec!["sent".into()],
        persisted_attachments,
    );
    summary.to = to;
    summary.cc = cc;
    persist_sent_email(&app, &state, &summary)?;

    Ok(GmailSendResult {
        message_id: outcome.message_id,
        thread_id,
        sent_at: outcome.sent_at,
    })
}

// ─── Tauri-store helpers (metadata only) ────────────────────────────────────

fn write_account_meta(app: &AppHandle, email: &str, meta: GmailAccountMeta) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut accounts = read_all_accounts(&store);
    accounts.insert(email.to_string(), meta);
    store.set(
        STORE_KEY,
        serde_json::to_value(&accounts).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

fn read_account_meta(app: &AppHandle, email: &str) -> Result<Option<GmailAccountMeta>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    Ok(read_all_accounts(&store).remove(email))
}

fn clear_account_meta(app: &AppHandle, email: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut accounts = read_all_accounts(&store);
    if accounts.remove(email).is_none() {
        return Ok(());
    }
    store.set(
        STORE_KEY,
        serde_json::to_value(&accounts).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

fn read_all_accounts(
    store: &tauri_plugin_store::Store<tauri::Wry>,
) -> std::collections::HashMap<String, GmailAccountMeta> {
    store
        .get(STORE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn read_all_accounts_from_app(
    app: &AppHandle,
) -> Result<std::collections::HashMap<String, GmailAccountMeta>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    Ok(read_all_accounts(&store))
}

// ─── Credential resolution ──────────────────────────────────────────────────

/// Resolve an account's App Password, priming the in-memory cache so the
/// rest of the session is prompt-free.
///
/// Order:
///   1. In-memory cache (`CredsCache`) — set on add and on first resolve.
///   2. Dev env (`GMAIL_EMAIL`/`GMAIL_APP_PASSWORD`, `.env.local`).
///   3. Private app-data credential store.
///   4. Legacy plaintext config value, migrated into the credential store.
///   5. Legacy OS keychain, imported once as the final keychain read.
pub(crate) fn resolve_credentials(
    app: &AppHandle,
    state: &AppState,
    email: &str,
) -> Result<creds::Credentials, String> {
    let email = email.trim();
    if let Some(c) = state.gmail_creds.peek(email) {
        return Ok(c);
    }
    if let Some(c) = creds::env_or_local_for(email) {
        state.gmail_creds.set(c.clone());
        return Ok(c);
    }
    let broker = CredentialBroker::for_app(app)?;
    if let Some(c) = creds::persisted_for(&state.gmail_creds, &broker, email)? {
        return Ok(c);
    }
    if let Some(meta) = read_account_meta(app, email)? {
        if !meta.app_password.trim().is_empty() {
            let app_password = meta.app_password.trim().to_string();
            broker.save(&CredentialId::gmail(email), &app_password)?;
            scrub_plaintext_password(app, email, meta)?;
            let c = creds::Credentials {
                email: email.to_string(),
                app_password,
            };
            state.gmail_creds.set(c.clone());
            return Ok(c);
        }
    }
    if let Some(app_password) = creds::legacy_keychain_password(email) {
        broker.save(&CredentialId::gmail(email), &app_password)?;
        if let Err(error) = creds::forget_legacy_keychain(email) {
            eprintln!("forget migrated Gmail keychain entry for {email}: {error}");
        }
        let c = creds::Credentials {
            email: email.to_string(),
            app_password,
        };
        state.gmail_creds.set(c.clone());
        return Ok(c);
    }
    Err(CredsError::NotFound {
        email: email.to_string(),
    }
    .to_string())
}

/// Rewrite legacy metadata after moving its plaintext secret to the broker.
fn scrub_plaintext_password(
    app: &AppHandle,
    email: &str,
    mut meta: GmailAccountMeta,
) -> Result<(), String> {
    meta.app_password.clear();
    meta.credential_configured = true;
    write_account_meta(app, email, meta)
}

// ─── Error mapping ──────────────────────────────────────────────────────────

fn imap_err_to_string(e: imap_client::ImapError) -> String {
    match &e {
        imap_client::ImapError::AuthFailed { email, message } => {
            // Surface a clean "you need to re-enter your app password"
            // message rather than the raw IMAP wire error. The frontend
            // banner pattern from Design D6 will key off this prefix.
            format!("auth_failed: {email}: {message}")
        }
        _ => e.to_string(),
    }
}

fn smtp_err_to_string(e: smtp_client::SmtpError, email: &str) -> String {
    // SMTP auth failures surface as Transport errors with a 535 code.
    // Map them to the same `auth_failed:` prefix the IMAP path uses so
    // the frontend banner pattern keys off one signal regardless of
    // which Gmail subsystem rejected the App Password.
    let s = e.to_string();
    if s.contains("535") || s.to_lowercase().contains("authentication") {
        return format!("auth_failed: {email}: {s}");
    }
    s
}

fn choose_thread_id(
    local_id: &str,
    wire_message_id: Option<&str>,
    thread_root_message_id: Option<&str>,
) -> String {
    thread_root_message_id
        .or(wire_message_id)
        .map(strip_brackets)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| local_id.to_string())
}

fn thread_id_for_parsed(
    account_email: &str,
    local_id: &str,
    parsed: &parse::ParsedMessage,
) -> String {
    let raw_thread_id = if parsed.gm_thrid != 0 {
        format!("gmail-thread-{:x}", parsed.gm_thrid)
    } else {
        choose_thread_id(
            local_id,
            (!parsed.message_id.is_empty()).then_some(parsed.message_id.as_str()),
            parsed.thread_root_message_id.as_deref(),
        )
    };
    account_scoped_thread_id(account_email, &raw_thread_id)
}

fn sent_thread_id_for_parsed(
    account_email: &str,
    local_id: &str,
    parsed: &parse::ParsedMessage,
    existing: Option<&EmailSummary>,
) -> String {
    existing
        .map(|email| email.thread_id.trim())
        .filter(|thread_id| !thread_id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| thread_id_for_parsed(account_email, local_id, parsed))
}

fn save_parsed_attachments(
    state: &State<AppState>,
    vault: &Path,
    message_id: &str,
    parsed: &parse::ParsedMessage,
) -> Vec<Attachment> {
    parsed
        .attachments
        .iter()
        .filter_map(|attachment| {
            save_attachment_bytes(
                state,
                vault,
                message_id,
                &attachment.id,
                &attachment.filename,
                &attachment.content_type,
                &attachment.bytes,
            )
            .map_err(|_| eprintln!("gmail: skipped one attachment"))
            .ok()
        })
        .collect()
}

fn build_summary_from_parsed(
    id: String,
    wire_message_id: String,
    thread_id: String,
    inbox: String,
    parsed: &parse::ParsedMessage,
    labels: Vec<String>,
    attachments: Vec<Attachment>,
) -> EmailSummary {
    let mut summary = build_email_summary(
        id,
        wire_message_id,
        thread_id,
        inbox,
        parsed.from.clone(),
        parsed.from_email.clone(),
        parsed.subject.clone(),
        parsed.body.clone(),
        parsed.html.clone(),
        parsed.date.clone(),
        labels,
        attachments,
    );
    summary.to = parsed.to.clone();
    summary.cc = parsed.cc.clone();
    summary
}

// ─── Subject-based conversation grouping ────────────────────────────────────
//
// Gmail's own conversation id (X-GM-THRID) is unavailable — imap-proto 0.10
// can't parse the extension — so threading runs on RFC 5322 headers alone.
// That is strictly weaker than Gmail: a sender who fires the same subject
// twice without References (transactional mail, notification bursts) produces
// one Gmail conversation but N Woodshed rows, which reads as duplicated mail.
//
// We recover the missing grouping the way mail clients did before Gmail:
// sender plus normalized subject, bounded by a time window. The window is what
// keeps a monthly newsletter with a fixed subject from collapsing a year of
// mail into a single row.

/// How close together two same-subject, same-sender messages must be before we
/// treat them as one conversation.
const SUBJECT_THREAD_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;

/// Grouping key for a message that carries no reply headers: sender address
/// plus its subject with reply/forward prefixes and whitespace normalized
/// away. `None` when either half is empty — an empty key would group every
/// subject-less message in the account into one row.
fn conversation_key(from_email: &str, subject: &str) -> Option<String> {
    let sender = from_email.trim().to_lowercase();
    let subject = normalize_subject(subject);
    if sender.is_empty() || subject.is_empty() {
        return None;
    }
    // `\u{1}` can't occur in either half, so the join is unambiguous.
    Some(format!("{sender}\u{1}{subject}"))
}

/// Strip any run of leading `Re:` / `Fwd:` / `Fw:` markers, collapse internal
/// whitespace, and lowercase. `Re: Re: Your  bill` and `your bill` match.
fn normalize_subject(subject: &str) -> String {
    let mut rest = subject.trim();
    while let Some(stripped) = strip_reply_prefix(rest) {
        rest = stripped.trim_start();
    }
    rest.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn strip_reply_prefix(subject: &str) -> Option<&str> {
    const PREFIXES: [&str; 3] = ["re:", "fwd:", "fw:"];
    let lowered = subject.trim_start().to_lowercase();
    PREFIXES
        .iter()
        .find(|prefix| lowered.starts_with(*prefix))
        .map(|prefix| &subject.trim_start()[prefix.len()..])
}

/// Assigns thread ids to messages that arrive without reply headers.
///
/// The oldest message of a same-key run anchors the conversation and keeps its
/// own thread id; later members adopt it. Anchoring on the oldest rather than
/// the most recent is what makes this stable — re-syncing a message finds the
/// same anchor and lands on the same thread it had last time.
#[derive(Debug, Default)]
struct ConversationThreads {
    /// conversation key → (anchor timestamp in epoch seconds, thread id).
    anchors: std::collections::HashMap<String, (i64, String)>,
}

impl ConversationThreads {
    /// Seed from records already on disk so a burst that straddles two syncs
    /// still converges on one thread.
    fn seed(&mut self, existing: &[EmailSummary]) {
        for email in existing {
            let Some(key) = conversation_key(&email.from_email, &email.subject) else {
                continue;
            };
            let Some(at) = epoch_seconds(&email.date) else {
                continue;
            };
            self.offer(key, at, email.thread_id.clone());
        }
    }

    /// Resolve the thread id for one message, remembering it as a potential
    /// anchor for later members. `proposed` is the caller's header-derived
    /// thread id, used when nothing else in the window matches.
    fn resolve(&mut self, from_email: &str, subject: &str, date: &str, proposed: String) -> String {
        let (Some(key), Some(at)) = (conversation_key(from_email, subject), epoch_seconds(date))
        else {
            return proposed;
        };
        if let Some((anchor_at, thread_id)) = self.anchors.get(&key) {
            if (at - *anchor_at).abs() <= SUBJECT_THREAD_WINDOW_SECS {
                // Extend the run backwards when this message predates the
                // anchor, so arrival order can't change the outcome.
                let (anchor_at, thread_id) = (*anchor_at.min(&at), thread_id.clone());
                self.anchors.insert(key, (anchor_at, thread_id.clone()));
                return thread_id;
            }
        }
        // Nothing within the window: this message starts a new run, and later
        // members measure their distance from here rather than from a stale
        // anchor months in the past.
        self.anchors.insert(key, (at, proposed.clone()));
        proposed
    }

    /// Keep the earliest candidate per key: a later message joins the run that
    /// already exists rather than starting a competing one.
    fn offer(&mut self, key: String, at: i64, thread_id: String) {
        match self.anchors.get(&key) {
            Some((anchor_at, _)) if *anchor_at <= at => {}
            _ => {
                self.anchors.insert(key, (at, thread_id));
            }
        }
    }
}

fn epoch_seconds(date: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(date)
        .ok()
        .map(|dt| dt.timestamp())
}

// ─── Stranded-identity backfill ─────────────────────────────────────────────

/// Local inbox records belonging to one account, oldest first.
fn account_inbox_records(vault: &std::path::Path, inbox: &str) -> Vec<EmailSummary> {
    let mut records: Vec<EmailSummary> =
        crate::commands::mail::read_inbox_dir(&crate::vault::collection_dir(vault, "inbox"))
            .into_iter()
            .filter(|email| email.inbox == inbox)
            .collect();
    records.sort_by(crate::commands::mail::email_date_cmp);
    records
}

/// True when a record's thread id is the "no usable header" fallback — its own
/// local UID identity. Records written before the wire Message-ID fallback
/// existed are stuck this way, and a record stuck this way can never merge
/// with replies that arrive later carrying the real conversation root.
fn is_uid_fallback_thread(email: &EmailSummary, account_email: &str) -> bool {
    email.thread_id == account_scoped_thread_id(account_email, &email.id)
}

/// Repair local records that sync can no longer reach.
///
/// `gmail_sync_recent` only rewrites the newest N messages per account, so a
/// record older than that window keeps whatever identity scheme was current
/// when it was written — permanently. The full-inbox ENVELOPE pass already
/// carries every message's wire Message-ID, which is exactly what those
/// records are missing, so we can repair them without another roundtrip.
///
/// Idempotent: a record whose `message_id` and thread id already agree with
/// the snapshot is left untouched, so repeat syncs write nothing.
fn backfill_stranded_identities(
    app: &AppHandle,
    state: &State<'_, AppState>,
    vault: &std::path::Path,
    account_email: &str,
    inbox: &str,
    snapshot: &imap_client::InboxSnapshot,
    snapshot_epoch: u64,
) {
    if snapshot.wire_message_ids.is_empty() {
        return;
    }

    let records = account_inbox_records(vault, inbox);
    // Seed from records that already carry a real conversation root so
    // repaired records join existing threads instead of starting rivals.
    let mut conversations = ConversationThreads::default();
    conversations.seed(
        &records
            .iter()
            .filter(|email| !is_uid_fallback_thread(email, account_email))
            .cloned()
            .collect::<Vec<_>>(),
    );

    for summary in records {
        let Some(wire_message_id) = snapshot.wire_message_ids.get(&summary.id) else {
            continue;
        };
        let stranded_thread = is_uid_fallback_thread(&summary, account_email);
        if summary.message_id == *wire_message_id && !stranded_thread {
            continue;
        }

        // `read_inbox_dir` yields frontmatter-only summaries with the body
        // stripped; rewriting one of those verbatim would erase the message
        // text. Re-read the whole record before touching it.
        let Some(path) = crate::commands::mail::find_email_path(vault, "inbox", &summary.id) else {
            continue;
        };
        let Some(mut email) = crate::commands::mail::load_email_from_path(&path) else {
            continue;
        };

        email.message_id = wire_message_id.clone();
        if stranded_thread {
            // A record on the UID fallback had neither References nor
            // In-Reply-To, so its own wire Message-ID is the conversation
            // root — the same value a fresh sync would derive today.
            let proposed = account_scoped_thread_id(account_email, wire_message_id);
            let (from_email, subject, date) = (
                email.from_email.clone(),
                email.subject.clone(),
                email.date.clone(),
            );
            email.thread_id = conversations.resolve(&from_email, &subject, &date, proposed);
        }

        if let Err(e) =
            crate::commands::mail::persist_inbox_email(app, state, &email, snapshot_epoch)
        {
            eprintln!("gmail: backfill failed for {}: {e}", email.id);
        }
    }
}

/// Thread identifiers are local UI grouping keys, so they must include the
/// receiving/sending account. The same RFC Message-ID can legitimately be
/// delivered to two configured accounts; treating it as global would make
/// thread actions cross account boundaries.
pub(crate) fn account_scoped_thread_id(account_email: &str, thread_id: &str) -> String {
    let prefix = format!(
        "gmail-thread-{}:",
        imap_client::account_fingerprint(account_email)
    );
    if thread_id.starts_with(&prefix) {
        return thread_id.to_string();
    }
    format!("{prefix}{}", strip_brackets(thread_id))
}

fn wire_message_id(email: &EmailSummary) -> &str {
    if email.message_id.trim().is_empty() {
        &email.id
    } else {
        &email.message_id
    }
}

fn decode_outgoing_attachments(
    attachments: Vec<GmailOutgoingAttachment>,
) -> Result<Vec<smtp_client::OutgoingAttachment>, String> {
    if attachments.len() > MAX_OUTGOING_ATTACHMENT_COUNT {
        return Err(format!(
            "too many attachments (maximum {MAX_OUTGOING_ATTACHMENT_COUNT})"
        ));
    }

    let mut total = 0_usize;
    let mut decoded = Vec::with_capacity(attachments.len());
    for (index, attachment) in attachments.into_iter().enumerate() {
        let max_encoded_len = MAX_OUTGOING_ATTACHMENT_BYTES.div_ceil(3) * 4;
        if attachment.data_base64.len() > max_encoded_len + 4 {
            return Err("attachment exceeds the 10 MB limit".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(attachment.data_base64.as_bytes())
            .map_err(|_| "attachment data is not valid base64".to_string())?;
        if bytes.len() > MAX_OUTGOING_ATTACHMENT_BYTES {
            return Err("attachment exceeds the 10 MB limit".into());
        }
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| "attachment size overflow".to_string())?;
        if total > MAX_OUTGOING_ATTACHMENTS_TOTAL_BYTES {
            return Err("attachments exceed the 20 MB total limit".into());
        }

        let filename =
            sanitize_attachment_filename(&attachment.filename, &format!("outgoing-{index}"));
        let content_type = attachment.content_type.trim();
        if content_type.len() > 127 {
            return Err("attachment content type is too long".into());
        }
        decoded.push(smtp_client::OutgoingAttachment {
            filename,
            content_type: if content_type.is_empty() {
                "application/octet-stream".into()
            } else {
                content_type.to_string()
            },
            bytes,
        });
    }
    Ok(decoded)
}

fn persist_outgoing_attachments(
    state: &State<AppState>,
    vault: &std::path::Path,
    message_id: &str,
    attachments: &[smtp_client::OutgoingAttachment],
) -> Vec<Attachment> {
    attachments
        .iter()
        .enumerate()
        .filter_map(|(index, attachment)| {
            match save_attachment_bytes(
                state,
                vault,
                message_id,
                &index.to_string(),
                &attachment.filename,
                &attachment.content_type,
                &attachment.bytes,
            ) {
                Ok(metadata) => Some(metadata),
                Err(_) => {
                    // SMTP already accepted the message. Keep the sent record
                    // recoverable without logging private filenames or paths.
                    eprintln!("gmail: could not cache a sent attachment locally");
                    None
                }
            }
        })
        .collect()
}

#[cfg(test)]
mod credential_metadata_tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn gmail_metadata_never_serializes_app_password() {
        let meta = GmailAccountMeta {
            display_name: "Work".into(),
            sender_name: "A User".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            app_password: "super-secret".into(),
            credential_configured: true,
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(!json.contains("super-secret"));
        assert!(!json.contains("appPassword"));
        assert!(json.contains("credentialConfigured"));
    }

    #[test]
    fn replies_share_the_root_wire_message_id_when_gmail_thread_ids_are_unavailable() {
        let original = choose_thread_id(
            "gmail-uid-account-42-7",
            Some("root-message@example.test"),
            None,
        );
        let reply = choose_thread_id(
            "gmail-uid-account-42-8",
            Some("reply-message@example.test"),
            Some("root-message@example.test"),
        );

        assert_eq!(original, "root-message@example.test");
        assert_eq!(reply, original);
    }

    #[test]
    fn sent_and_received_replies_with_the_same_root_share_a_local_thread() {
        let received = parse::parse(&imap_client::RawMessage {
            body: b"From: Person <person@example.test>\r\nTo: owner@example.test\r\nSubject: Re: Topic\r\nMessage-ID: <received@example.test>\r\nReferences: <root@example.test>\r\n\r\nReceived reply"
                .to_vec(),
            uid: 1,
            gm_msgid: 0,
            gm_thrid: 0,
            seen: true,
            internal_date: None,
        });
        let sent = parse::parse(&imap_client::RawMessage {
            body: b"From: Owner <owner@example.test>\r\nTo: person@example.test\r\nSubject: Re: Topic\r\nMessage-ID: <sent@example.test>\r\nReferences: <root@example.test>\r\n\r\nSent reply"
                .to_vec(),
            uid: 2,
            gm_msgid: 0,
            gm_thrid: 0,
            seen: true,
            internal_date: None,
        });

        assert_eq!(
            thread_id_for_parsed("owner@example.test", "received-local", &received),
            thread_id_for_parsed("owner@example.test", "sent-local", &sent),
        );
    }

    #[test]
    fn sent_resync_preserves_an_existing_canonical_thread() {
        let parsed = parse::parse(&imap_client::RawMessage {
            body: b"From: Owner <owner@example.test>\r\nTo: person@example.test\r\nSubject: Re: Topic\r\nMessage-ID: <sent@example.test>\r\nReferences: <immediate-parent@example.test>\r\n\r\nSent reply"
                .to_vec(),
            uid: 3,
            gm_msgid: 0,
            gm_thrid: 0,
            seen: true,
            internal_date: None,
        });
        let existing = conversation_summary(
            "sent@example.test",
            "Re: Topic",
            "2026-08-03T12:00:00Z",
            "gmail-account-owner-example-test-conversation-root",
        );

        assert_eq!(
            sent_thread_id_for_parsed(
                "owner@example.test",
                "sent@example.test",
                &parsed,
                Some(&existing),
            ),
            existing.thread_id,
        );
    }

    #[test]
    fn sent_wire_message_becomes_a_sent_summary_with_recipients() {
        let parsed = parse::parse(&imap_client::RawMessage {
            body: b"From: Owner <owner@example.test>\r\nTo: Person <person@example.test>\r\nCc: Observer <observer@example.test>\r\nSubject: Re: Topic\r\nMessage-ID: <sent@example.test>\r\nReferences: <root@example.test>\r\n\r\nSent reply"
                .to_vec(),
            uid: 4,
            gm_msgid: 0,
            gm_thrid: 0,
            seen: true,
            internal_date: None,
        });
        let summary = build_summary_from_parsed(
            "sent@example.test".into(),
            parsed.message_id.clone(),
            thread_id_for_parsed("owner@example.test", "sent@example.test", &parsed),
            "gmail:owner@example.test".into(),
            &parsed,
            vec!["sent".into(), "read".into()],
            Vec::new(),
        );

        assert_eq!(summary.to, vec!["person@example.test"]);
        assert_eq!(summary.cc, vec!["observer@example.test"]);
        assert_eq!(summary.labels, vec!["sent", "read"]);
        assert_eq!(
            summary.thread_id,
            account_scoped_thread_id("owner@example.test", "root@example.test"),
        );
    }

    fn conversation_summary(id: &str, subject: &str, date: &str, thread_id: &str) -> EmailSummary {
        let mut email = build_email_summary(
            id.into(),
            String::new(),
            thread_id.into(),
            "gmail:owner@example.test".into(),
            "Billing".into(),
            "billing@example.test".into(),
            subject.into(),
            String::new(),
            None,
            date.into(),
            vec!["inbox".into(), "unread".into()],
            Vec::new(),
        );
        email.thread_id = thread_id.into();
        email
    }

    #[test]
    fn reply_and_forward_prefixes_do_not_split_a_subject() {
        assert_eq!(
            normalize_subject("Re: Fwd:  Issue   processing"),
            "issue processing"
        );
        assert_eq!(normalize_subject("issue processing"), "issue processing");
        assert_eq!(
            normalize_subject("RE: Re: Issue processing"),
            "issue processing"
        );
    }

    #[test]
    fn a_conversation_key_needs_both_a_sender_and_a_subject() {
        assert!(conversation_key("billing@example.test", "  ").is_none());
        assert!(conversation_key("  ", "Issue processing payment").is_none());
        assert_eq!(
            conversation_key("Billing@Example.test", "Re: Issue"),
            conversation_key("billing@example.test", "Issue"),
        );
    }

    // The reported bug: one Gmail conversation, two identical notifications a
    // second apart, no References header on either. Without subject grouping
    // each renders as its own inbox row and reads as duplicated mail.
    #[test]
    fn same_subject_bursts_from_one_sender_collapse_into_one_thread() {
        let mut conversations = ConversationThreads::default();
        let first = conversations.resolve(
            "billing@example.test",
            "Issue processing payment",
            "2026-07-28T20:34:47+00:00",
            "thread-first".into(),
        );
        let second = conversations.resolve(
            "billing@example.test",
            "Issue processing payment",
            "2026-07-28T20:34:48+00:00",
            "thread-second".into(),
        );

        assert_eq!(first, "thread-first");
        assert_eq!(second, first, "a burst must not render as two rows");
    }

    // The other half of the trade: a recurring notice with a fixed subject
    // must not collapse months of mail behind a single row.
    #[test]
    fn same_subject_outside_the_window_starts_a_new_thread() {
        let mut conversations = ConversationThreads::default();
        let january = conversations.resolve(
            "billing@example.test",
            "Your bill is due soon",
            "2026-01-05T10:00:00+00:00",
            "thread-january".into(),
        );
        let february = conversations.resolve(
            "billing@example.test",
            "Your bill is due soon",
            "2026-02-05T10:00:00+00:00",
            "thread-february".into(),
        );
        let february_again = conversations.resolve(
            "billing@example.test",
            "Your bill is due soon",
            "2026-02-05T10:00:04+00:00",
            "thread-february-second-notice".into(),
        );

        assert_eq!(january, "thread-january");
        assert_eq!(february, "thread-february");
        // The window slides: February's pair groups with each other, not with
        // the stale January anchor.
        assert_eq!(february_again, "thread-february");
    }

    // Thread ids are persisted, so a re-sync of the same messages has to land
    // on the same answer or the inbox reshuffles on every refresh.
    #[test]
    fn resolving_the_same_messages_again_is_stable() {
        let run = || {
            let mut conversations = ConversationThreads::default();
            conversations.seed(&[
                conversation_summary(
                    "gmail-uid-acct-3-1",
                    "Issue processing payment",
                    "2026-07-28T20:34:47+00:00",
                    "thread-anchor",
                ),
                conversation_summary(
                    "gmail-uid-acct-3-2",
                    "Issue processing payment",
                    "2026-07-28T20:34:48+00:00",
                    "thread-anchor",
                ),
            ]);
            conversations.resolve(
                "billing@example.test",
                "Issue processing payment",
                "2026-07-28T20:34:48+00:00",
                "thread-freshly-proposed".into(),
            )
        };

        assert_eq!(run(), "thread-anchor");
        assert_eq!(run(), run());
    }

    #[test]
    fn seeding_prefers_the_oldest_local_record_as_the_anchor() {
        let mut conversations = ConversationThreads::default();
        conversations.seed(&[
            conversation_summary(
                "gmail-uid-acct-3-2",
                "Issue processing payment",
                "2026-07-28T20:34:48+00:00",
                "thread-newer",
            ),
            conversation_summary(
                "gmail-uid-acct-3-1",
                "Issue processing payment",
                "2026-07-28T20:34:47+00:00",
                "thread-older",
            ),
        ]);

        let resolved = conversations.resolve(
            "billing@example.test",
            "Issue processing payment",
            "2026-07-28T20:34:49+00:00",
            "thread-proposed".into(),
        );
        assert_eq!(resolved, "thread-older");
    }

    #[test]
    fn a_message_without_a_usable_key_keeps_the_header_derived_thread() {
        let mut conversations = ConversationThreads::default();
        let resolved = conversations.resolve(
            "billing@example.test",
            "",
            "2026-07-28T20:34:47+00:00",
            "thread-from-headers".into(),
        );
        assert_eq!(resolved, "thread-from-headers");
    }

    // Records written before the wire-Message-ID fallback existed thread
    // against their own local UID and can never merge with later replies.
    // Recognising them is what lets the backfill know which ones to repair.
    #[test]
    fn uid_fallback_threads_are_distinguishable_from_real_conversation_roots() {
        let account = "owner@example.test";
        let stranded = conversation_summary(
            "gmail-uid-acct-3-117406",
            "Demo vault generator",
            "2026-07-27T21:32:28-07:00",
            &account_scoped_thread_id(account, "gmail-uid-acct-3-117406"),
        );
        let healthy = conversation_summary(
            "gmail-uid-acct-3-117407",
            "Re: Demo vault generator",
            "2026-07-27T21:34:51-07:00",
            &account_scoped_thread_id(account, "example/repo/pull/15@example.test"),
        );

        assert!(is_uid_fallback_thread(&stranded, account));
        assert!(!is_uid_fallback_thread(&healthy, account));
    }

    #[test]
    fn outgoing_attachments_decode_only_inside_the_bounded_mail_command() {
        let decoded = decode_outgoing_attachments(vec![GmailOutgoingAttachment {
            filename: "brief.txt".into(),
            content_type: "text/plain".into(),
            data_base64: "aGVsbG8=".into(),
        }])
        .expect("valid attachment");

        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].filename, "brief.txt");
        assert_eq!(decoded[0].bytes, b"hello");

        let oversized = GmailOutgoingAttachment {
            filename: "large.bin".into(),
            content_type: "application/octet-stream".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(vec![
                0_u8;
                MAX_OUTGOING_ATTACHMENT_BYTES
                    + 1
            ]),
        };
        assert!(decode_outgoing_attachments(vec![oversized]).is_err());
    }

    #[test]
    fn outgoing_attachment_ingress_rejects_malformed_and_excess_inputs() {
        let malformed = GmailOutgoingAttachment {
            filename: "brief.txt".into(),
            content_type: "text/plain".into(),
            data_base64: "not base64!".into(),
        };
        assert!(decode_outgoing_attachments(vec![malformed])
            .unwrap_err()
            .contains("valid base64"));

        let too_many = (0..=MAX_OUTGOING_ATTACHMENT_COUNT)
            .map(|index| GmailOutgoingAttachment {
                filename: format!("file-{index}.txt"),
                content_type: "text/plain".into(),
                data_base64: String::new(),
            })
            .collect();
        assert!(decode_outgoing_attachments(too_many)
            .unwrap_err()
            .contains("too many attachments"));

        let invalid_content_type = GmailOutgoingAttachment {
            filename: "brief.txt".into(),
            content_type: "x".repeat(128),
            data_base64: String::new(),
        };
        assert!(decode_outgoing_attachments(vec![invalid_content_type])
            .unwrap_err()
            .contains("content type is too long"));
    }

    #[test]
    fn outgoing_attachment_ingress_enforces_aggregate_budget_and_sanitizes_names() {
        let first = GmailOutgoingAttachment {
            filename: "a".repeat(400),
            content_type: "application/octet-stream".into(),
            data_base64: base64::engine::general_purpose::STANDARD
                .encode(vec![0_u8; MAX_OUTGOING_ATTACHMENT_BYTES]),
        };
        let second = GmailOutgoingAttachment {
            filename: "second.bin".into(),
            content_type: "application/octet-stream".into(),
            data_base64: base64::engine::general_purpose::STANDARD
                .encode(vec![0_u8; MAX_OUTGOING_ATTACHMENT_BYTES]),
        };
        let final_byte = GmailOutgoingAttachment {
            filename: "final.bin".into(),
            content_type: "application/octet-stream".into(),
            data_base64: "AA==".into(),
        };

        let decoded = decode_outgoing_attachments(vec![first.clone()]).expect("within budget");
        assert!(decoded[0].filename.len() <= 160);
        assert!(decode_outgoing_attachments(vec![first, second, final_byte])
            .unwrap_err()
            .contains("20 MB total limit"));
    }

    #[test]
    fn account_scoped_threads_do_not_collide_and_are_idempotent() {
        let first = account_scoped_thread_id("first@example.test", "root@example.test");
        let second = account_scoped_thread_id("second@example.test", "root@example.test");

        assert_ne!(first, second);
        assert_eq!(
            account_scoped_thread_id("first@example.test", &first),
            first
        );
    }
}
