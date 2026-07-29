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
use crate::gmail::{creds, imap_client, parse, smtp_client, CredsError};
use crate::AppState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::time::Instant;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

/// Tauri store file (shared with config — same single source for all
/// app-level metadata). Gmail account metadata (display name, created-at)
/// lives under the `gmail_accounts` key keyed by email. Secrets stay in
/// the OS keychain.
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
    /// Pre-keychain builds wrote the secret here. Deserialize it once for
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
    /// Newly-persisted message IDs. Useful for UI toast.
    pub written: Vec<String>,
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

/// Add (or update) a Gmail account: persist the App Password to the OS
/// keychain, the metadata (display name, created-at) to the Tauri store,
/// and prime the in-memory creds cache so subsequent operations don't
/// re-prompt for keychain access.
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
    creds::store(&email, &app_password).map_err(creds_err_to_string)?;
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
/// sets it. The keychain App Password is untouched.
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

/// Remove a Gmail account by email. Drops the keychain secret, the
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
    creds::forget(&email).map_err(creds_err_to_string)?;
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
    // Reconciliation (below) needs creds after the fetch moves them into
    // the blocking closure, so keep a clone.
    let creds_for_reconcile = credentials.clone();

    // The imap crate is sync. Run the fetch on a blocking thread so we
    // don't park a Tokio worker. The pool keeps the IMAP socket alive
    // across calls so subsequent syncs skip the TLS+LOGIN handshake.
    let snapshot_epoch = state.mail_mutation_epoch.load(Ordering::Acquire);
    let pool = state.gmail_pool.clone();
    let batch =
        tokio::task::spawn_blocking(move || imap_client::fetch_recent(&pool, &credentials, limit))
            .await
            .map_err(|join_err| format!("gmail sync thread panicked: {join_err}"))?
            .map_err(imap_err_to_string)?;

    let inbox = inbox_id(&email);
    let vault = vault_root(&app)?;
    // Filename cleanup is cosmetic and potentially O(n), so run it only on
    // an explicit sync rather than every paginated inbox read.
    let _ = crate::commands::mail::migrate_legacy_filenames(&vault, &state);
    let mut written = Vec::with_capacity(batch.messages.len());
    let fetched = batch.messages.len();

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
        let raw_thread_id = if parsed.gm_thrid != 0 {
            format!("gmail-thread-{:x}", parsed.gm_thrid)
        } else {
            choose_thread_id(
                &id,
                (!wire_message_id.is_empty()).then_some(wire_message_id.as_str()),
                parsed.thread_root_message_id.as_deref(),
            )
        };
        let thread_id = account_scoped_thread_id(&email, &raw_thread_id);

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
        let mut attachments: Vec<Attachment> = Vec::new();
        if !parsed.attachments.is_empty() {
            for a in &parsed.attachments {
                match save_attachment_bytes(
                    &state,
                    &vault,
                    &id,
                    &a.id,
                    &a.filename,
                    &a.content_type,
                    &a.bytes,
                ) {
                    Ok(meta) => attachments.push(meta),
                    Err(e) => eprintln!("gmail: skip attachment {} of {}: {e}", a.filename, id),
                }
            }
        }

        let summary = build_email_summary(
            id.clone(),
            wire_message_id,
            thread_id,
            inbox.clone(),
            parsed.from.clone(),
            parsed.from_email.clone(),
            parsed.subject.clone(),
            parsed.body.clone(),
            parsed.html.clone(),
            parsed.date.clone(),
            labels,
            attachments,
        );

        match persist_inbox_email(&app, &state, &summary, snapshot_epoch) {
            Ok(Some(_)) => {
                let mut superseded = vec![legacy_uid.clone()];
                if parsed.gm_msgid != 0 {
                    superseded.push(format!("gmail-{:x}", parsed.gm_msgid));
                }
                if !parsed.message_id.is_empty() {
                    superseded.push(parsed.message_id.clone());
                }
                for obsolete_id in superseded {
                    crate::commands::mail::trash_superseded_email_identity(
                        &app,
                        &state,
                        &vault,
                        &obsolete_id,
                        &inbox,
                    );
                }
                written.push(id)
            }
            Ok(None) => {}
            Err(e) => eprintln!("gmail: failed to persist {id}: {e}"),
        }
    }

    // Reconcile: archive locally anything the user already handled in
    // Gmail (no longer in the Gmail inbox). Non-fatal — a reconcile
    // failure shouldn't fail the sync that just pulled fresh mail.
    let removed = match crate::commands::mail::reconcile_gmail_inbox(
        &app,
        &state,
        &vault,
        &inbox,
        &creds_for_reconcile,
        &written,
    )
    .await
    {
        Ok(n) => n,
        Err(e) => {
            eprintln!("gmail: reconcile failed for {email}: {e}");
            0
        }
    };

    Ok(GmailSyncResult {
        written,
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

    let summary = build_email_summary(
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

    let summary = build_email_summary(
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
    persist_sent_email(&app, &state, &summary)?;

    Ok(GmailSendResult {
        message_id: outcome.message_id,
        thread_id,
        sent_at: outcome.sent_at,
    })
}

// ─── Tauri-store helpers (metadata; secrets stay in keychain) ───────────────

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
///   3. OS credential store.
///   4. Legacy plaintext config value, migrated into the credential store.
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
    if let Some(app_password) = creds::keychain_password(email) {
        let c = creds::Credentials {
            email: email.to_string(),
            app_password,
        };
        state.gmail_creds.set(c.clone());
        return Ok(c);
    }
    if let Some(meta) = read_account_meta(app, email)? {
        if !meta.app_password.trim().is_empty() {
            let app_password = meta.app_password.trim().to_string();
            creds::store(email, &app_password).map_err(creds_err_to_string)?;
            scrub_plaintext_password(app, email, meta)?;
            let c = creds::Credentials {
                email: email.to_string(),
                app_password,
            };
            state.gmail_creds.set(c.clone());
            return Ok(c);
        }
    }
    Err(CredsError::NotFound {
        email: email.to_string(),
    }
    .to_string())
}

/// Rewrite legacy metadata after moving its plaintext secret to keychain.
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

fn creds_err_to_string(e: CredsError) -> String {
    e.to_string()
}

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
