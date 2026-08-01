// IMAP client for Gmail. Sync API (`imap` 2.4) — callers wrap in
// tokio::task::spawn_blocking when invoking from an async Tauri command.
//
// V1 scope: connect, login with App Password, SELECT INBOX, fetch the
// most-recent N messages by UID, return raw RFC822 bytes alongside the
// Gmail-specific X-GM-MSGID and X-GM-THRID extensions for stable IDs.
// No IDLE, no UIDVALIDITY tracking, no incremental sync — this is the
// "does the round trip work at all" slice. State machine + CONDSTORE
// land once the basic path is proven.

use crate::gmail::creds::Credentials;
use crate::gmail::pool::GmailImapPool;

const MAX_RAW_MESSAGE_BYTES: usize = 25 * 1024 * 1024;
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum ImapError {
    #[error("TLS error: {0}")]
    Tls(#[from] native_tls::Error),
    #[error("IMAP error: {0}")]
    Imap(#[from] imap::Error),
    #[error("auth failed for {email}: {message}")]
    AuthFailed { email: String, message: String },
    #[error("message {message_id} not found in Gmail INBOX")]
    MessageNotFound { message_id: String },
    #[error("inbox listing inconsistent: {exists} messages present but none parseable")]
    InboxListInconsistent { exists: u32 },
    #[error("Gmail INBOX did not report UIDVALIDITY; refusing an unsafe mutation")]
    MissingUidValidity,
    #[error("stored Gmail identity is stale or belongs to another account")]
    StaleRemoteIdentity,
    #[error("message id {message_id} matched multiple Gmail messages; refusing a bulk mutation")]
    AmbiguousMessageId { message_id: String },
}

/// One raw message fetched from IMAP, before MIME parsing. Carries the
/// Gmail-specific stable identifiers so downstream code can produce a
/// canonical filename / id without having to peek at headers.
#[derive(Debug, Clone)]
pub struct RawMessage {
    /// RFC822 wire bytes. Feed to `mail-parser` to get headers + body.
    pub body: Vec<u8>,
    /// IMAP UID (per-mailbox, per-UIDVALIDITY). Stable across this session;
    /// you'd persist it alongside UIDVALIDITY for incremental sync (later).
    pub uid: u32,
    /// Gmail's X-GM-MSGID — server-assigned, globally stable across all
    /// folders and forever. Use this as the canonical identity for a
    /// Gmail message even if the user later moves it between folders.
    pub gm_msgid: u64,
    /// Gmail's X-GM-THRID — the conversation ID. Same shape as msgid;
    /// shared across every message in a thread.
    pub gm_thrid: u64,
    /// IMAP `\Seen` flag at fetch time.
    pub seen: bool,
    /// `INTERNALDATE` — the server's idea of when the message arrived.
    /// We surface this rather than the message's `Date:` header because
    /// Date: can lie; INTERNALDATE is what the server saw.
    pub internal_date: Option<chrono::DateTime<chrono::FixedOffset>>,
}

#[derive(Debug, Clone)]
pub struct FetchBatch {
    pub uid_validity: u32,
    pub messages: Vec<RawMessage>,
}

/// Fetch the last `limit` messages from INBOX through the pooled session.
/// Returns raw bytes in chronological order (oldest first).
///
/// Blocking — call from `tokio::task::spawn_blocking`.
pub fn fetch_recent(
    pool: &GmailImapPool,
    creds: &Credentials,
    limit: usize,
) -> Result<FetchBatch, ImapError> {
    pool.with_session(creds, |session| {
        // The pool keeps INBOX selected; we re-issue NOOP-equivalent via
        // a fresh fetch each call. To pick up new mail since the session
        // was opened, refresh the `EXISTS` count via a SELECT roundtrip.
        // Cheap (one round trip) and avoids relying on stale state.
        let mailbox = session.select("INBOX")?;

        if mailbox.exists == 0 {
            return Ok(FetchBatch {
                uid_validity: mailbox.uid_validity.ok_or(ImapError::MissingUidValidity)?,
                messages: Vec::new(),
            });
        }
        let uid_validity = mailbox.uid_validity.ok_or(ImapError::MissingUidValidity)?;

        let total = mailbox.exists;
        let start = total.saturating_sub(limit as u32 - 1).max(1);
        let range = format!("{start}:{total}");

        // BODY.PEEK[] leaves \Seen alone — fetching in Woodshed shouldn't
        // mark mail as read in the user's other Gmail clients. X-GM-MSGID
        // / X-GM-THRID disabled because imap 2.4's parser chokes on them;
        // sync falls back to RFC 5322 Message-ID + References headers.
        // Request at most 25 MiB of each message so one pathological mailbox
        // item cannot force the IMAP parser to allocate an unbounded literal.
        // RFC822.SIZE lets us distinguish a genuinely small message from a
        // truncated partial response and skip the latter cleanly.
        let fetch_spec = "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.26214400>)";
        let fetches = session.fetch(&range, fetch_spec)?;

        let mut out = Vec::with_capacity(fetches.len());
        for f in fetches.iter() {
            if f.size
                .is_some_and(|size| size as usize > MAX_RAW_MESSAGE_BYTES)
            {
                eprintln!("gmail: skipped message larger than 25 MiB");
                continue;
            }
            let body = match f.body() {
                Some(b) => b.to_vec(),
                None => continue,
            };
            if body.len() > MAX_RAW_MESSAGE_BYTES {
                eprintln!("gmail: skipped oversized IMAP response");
                continue;
            }
            let uid = f.uid.unwrap_or(0);
            let seen = f
                .flags()
                .iter()
                .any(|fl| matches!(fl, imap::types::Flag::Seen));
            let internal_date = f.internal_date();
            out.push(RawMessage {
                body,
                uid,
                gm_msgid: 0,
                gm_thrid: 0,
                seen,
                internal_date,
            });
        }
        Ok(FetchBatch {
            uid_validity,
            messages: out,
        })
    })
}

/// Fetch the identity of EVERY message currently in INBOX, header-only
/// (no bodies). Used to reconcile the local inbox: any locally-stored
/// inbox message whose id isn't in this set has left the Gmail inbox
/// (archived, moved, or deleted directly in Gmail) and should be archived
/// locally so the app matches Gmail's inbox membership.
///
/// Each `ids` entry is the message's bare-or-bracketed RFC 5322 Message-ID
/// or its canonical UID identity — the same id shapes `commands::gmail`
/// persists. The caller normalizes both sides through `strip_brackets`
/// before comparing, so bracket form doesn't matter here. We read the
/// Message-ID from the parsed ENVELOPE (standard IMAP, cheap, no manual
/// header parsing); X-GM-MSGID stays disabled (imap-proto 0.10 can't parse
/// it).
///
/// Guard: if the mailbox reports messages (`EXISTS > 0`) but we parse zero
/// ids, we return `InboxListInconsistent` rather than an empty set — an
/// empty set tells the caller "the inbox is empty, archive everything
/// local," and a parse hiccup must never trigger a mass local archive.
///
/// The same ENVELOPE pass also records each message's canonical UID identity
/// alongside its wire Message-ID. Sync only rewrites the most recent N
/// messages per account, so records older than that window can be stranded on
/// a superseded identity scheme with no way to recover their wire id offline.
/// This map is that recovery path, and it costs no extra roundtrip.
///
/// Blocking — call from `tokio::task::spawn_blocking`.
pub fn fetch_inbox_snapshot(
    pool: &GmailImapPool,
    creds: &Credentials,
) -> Result<InboxSnapshot, ImapError> {
    pool.with_session(creds, |session| {
        let mailbox = session.select("INBOX")?;
        if mailbox.exists == 0 {
            return Ok(InboxSnapshot::default());
        }
        let uid_validity = mailbox.uid_validity.ok_or(ImapError::MissingUidValidity)?;
        let fetches = session.fetch("1:*", "(UID ENVELOPE)")?;
        let mut snapshot = InboxSnapshot {
            ids: std::collections::HashSet::with_capacity(fetches.len()),
            wire_message_ids: std::collections::HashMap::new(),
        };
        for f in fetches.iter() {
            let message_id = f
                .envelope()
                .and_then(|env| env.message_id.as_ref())
                .map(|raw| String::from_utf8_lossy(raw).trim().to_string())
                .filter(|s| !s.is_empty());
            if let Some(mid) = message_id.clone() {
                snapshot.ids.insert(mid);
            }
            // The canonical UID identity covers messages without an RFC
            // Message-ID, and is the key local records are addressed by.
            if let Some(uid) = f.uid {
                let canonical = canonical_uid_id(&creds.email, uid_validity, uid);
                if let Some(mid) = message_id {
                    snapshot
                        .wire_message_ids
                        .insert(canonical.clone(), strip_angle_brackets(&mid));
                }
                snapshot.ids.insert(canonical);
            }
        }
        if snapshot.ids.is_empty() {
            return Err(ImapError::InboxListInconsistent {
                exists: mailbox.exists,
            });
        }
        Ok(snapshot)
    })
}

/// Everything one full-inbox ENVELOPE pass tells us about a Gmail account.
#[derive(Debug, Default, Clone)]
pub struct InboxSnapshot {
    /// Every identity shape a local record might be stored under: the wire
    /// Message-ID and the canonical account+UIDVALIDITY+UID id.
    pub ids: std::collections::HashSet<String>,
    /// Canonical UID identity → wire Message-ID, for messages that have one.
    pub wire_message_ids: std::collections::HashMap<String, String>,
}

fn strip_angle_brackets(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .to_string()
}

/// Archive a message: mark it read AND remove it from INBOX. Archiving
/// always also marks read.
///
/// Gmail's IMAP settings define "archive" as expunging a message marked
/// `\Deleted` from INBOX. Mark `\Seen` and `\Deleted` together with a silent
/// UID STORE, then UID EXPUNGE only the target messages. The targeted expunge
/// matters: a plain EXPUNGE could also remove messages another client marked
/// deleted while this session was open.
pub fn archive_message(
    pool: &GmailImapPool,
    creds: &Credentials,
    message_id: &str,
) -> Result<(), ImapError> {
    pool.with_session(creds, |session| {
        let uids = lookup_uids_by_local_id(session, creds, message_id)?;
        if uids.is_empty() {
            return Err(ImapError::MessageNotFound {
                message_id: message_id.to_string(),
            });
        }
        let uid_set = join_uids(&uids);
        apply_archive_plan(session, &uid_set)?;
        Ok(())
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveCommand {
    StoreFlags(&'static str),
    UidExpunge,
}

fn archive_plan() -> [ArchiveCommand; 2] {
    [
        ArchiveCommand::StoreFlags("+FLAGS.SILENT (\\Seen \\Deleted)"),
        ArchiveCommand::UidExpunge,
    ]
}

fn apply_archive_plan(
    session: &mut imap::Session<native_tls::TlsStream<std::net::TcpStream>>,
    uid_set: &str,
) -> Result<(), ImapError> {
    for command in archive_plan() {
        match command {
            ArchiveCommand::StoreFlags(flags) => {
                session.uid_store(uid_set, flags)?;
            }
            ArchiveCommand::UidExpunge => {
                session.uid_expunge(uid_set)?;
            }
        }
    }
    Ok(())
}

/// Mark a message read on the server: `STORE +FLAGS.SILENT (\Seen)`.
/// `.SILENT` for the same reason as `archive_message` — keeps us off
/// the imap-proto FETCH parse path on extension-flavored responses.
pub fn mark_seen(
    pool: &GmailImapPool,
    creds: &Credentials,
    message_id: &str,
) -> Result<(), ImapError> {
    pool.with_session(creds, |session| {
        let uids = lookup_uids_by_local_id(session, creds, message_id)?;
        if uids.is_empty() {
            return Ok(());
        }
        let uid_set = join_uids(&uids);
        session.uid_store(&uid_set, "+FLAGS.SILENT (\\Seen)")?;
        Ok(())
    })
}

fn lookup_uids_by_local_id(
    session: &mut imap::Session<native_tls::TlsStream<std::net::TcpStream>>,
    creds: &Credentials,
    message_id: &str,
) -> Result<Vec<u32>, ImapError> {
    if let Some(remote) = gmail_uid_from_local_id(message_id) {
        let mailbox = session.select("INBOX")?;
        if remote.account != account_fingerprint(&creds.email)
            || mailbox.uid_validity != Some(remote.uid_validity)
        {
            return Err(ImapError::StaleRemoteIdentity);
        }
        return Ok(vec![remote.uid]);
    }
    if legacy_gmail_uid(message_id).is_some() {
        // A UID without both account identity and UIDVALIDITY can address a
        // different message after a mailbox reset. A later sync migrates these
        // local records to a canonical identity; mutations fail closed.
        return Err(ImapError::StaleRemoteIdentity);
    }

    if let Some(gm_msgid) = gmail_msgid_from_local_id(message_id) {
        let query = format!("X-GM-MSGID {gm_msgid}");
        let uids = session.uid_search(&query)?;
        let mut v: Vec<u32> = uids.into_iter().collect();
        v.sort();
        if !v.is_empty() {
            return Ok(v);
        }
    }

    lookup_uids_by_message_id(session, message_id)
}

fn lookup_uids_by_message_id(
    session: &mut imap::Session<native_tls::TlsStream<std::net::TcpStream>>,
    message_id: &str,
) -> Result<Vec<u32>, ImapError> {
    // IMAP HEADER search is case-insensitive substring on the unfolded
    // header value. Gmail's stored Message-ID is bracketed (`<x@y>`); we
    // strip brackets so the search matches whether the caller passed the
    // bare or bracketed form.
    let bare = message_id
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>');
    if bare.is_empty() {
        return Ok(Vec::new());
    }
    let query = format!("HEADER Message-ID \"{}\"", escape_imap_quoted(bare));
    let uids = session.uid_search(&query)?;
    let mut v: Vec<u32> = uids.into_iter().collect();
    v.sort();
    if v.is_empty() {
        return Ok(v);
    }

    // Gmail's HEADER search is a substring match. Re-fetch just the
    // candidate Message-ID headers and require an exact match before any
    // mutation. Never turn an ambiguous header into a bulk operation.
    let fetches = session.uid_fetch(join_uids(&v), "BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]")?;
    let expected = normalize_message_id(bare);
    let mut exact = Vec::new();
    for fetch in fetches.iter() {
        let Some(uid) = fetch.uid else { continue };
        let Some(body) = fetch.body() else { continue };
        let text = String::from_utf8_lossy(body);
        let actual = text.lines().find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.trim().eq_ignore_ascii_case("message-id"))
                .map(|(_, value)| normalize_message_id(value))
        });
        if actual.as_deref() == Some(expected.as_str()) {
            exact.push(uid);
        }
    }
    if exact.len() > 1 {
        return Err(ImapError::AmbiguousMessageId {
            message_id: message_id.to_string(),
        });
    }
    Ok(exact)
}

#[derive(Debug, PartialEq, Eq)]
struct RemoteUidIdentity {
    account: String,
    uid_validity: u32,
    uid: u32,
}

pub fn canonical_uid_id(email: &str, uid_validity: u32, uid: u32) -> String {
    format!(
        "gmail-uid-{}-{uid_validity}-{uid}",
        account_fingerprint(email)
    )
}

pub(crate) fn account_fingerprint(email: &str) -> String {
    let digest = Sha256::digest(email.trim().to_ascii_lowercase().as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn gmail_uid_from_local_id(message_id: &str) -> Option<RemoteUidIdentity> {
    let rest = message_id.strip_prefix("gmail-uid-")?;
    let parts: Vec<&str> = rest.split('-').collect();
    match parts.as_slice() {
        [account, uid_validity, uid] if account.len() == 16 => Some(RemoteUidIdentity {
            account: (*account).to_string(),
            uid_validity: uid_validity.parse().ok()?,
            uid: uid.parse().ok()?,
        }),
        _ => None,
    }
}

fn legacy_gmail_uid(message_id: &str) -> Option<u32> {
    message_id.strip_prefix("gmail-uid-")?.parse().ok()
}

fn escape_imap_quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn normalize_message_id(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim()
        .to_string()
}

fn gmail_msgid_from_local_id(message_id: &str) -> Option<u64> {
    let hex = message_id.strip_prefix("gmail-")?;
    if hex.starts_with("uid-") || hex.is_empty() {
        return None;
    }
    u64::from_str_radix(hex, 16).ok()
}

fn join_uids(uids: &[u32]) -> String {
    uids.iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_uid_fallback_local_ids() {
        assert_eq!(gmail_uid_from_local_id("gmail-uid-42"), None);
        assert_eq!(legacy_gmail_uid("gmail-uid-42"), Some(42));
        assert_eq!(
            gmail_uid_from_local_id("gmail-uid-0123456789abcdef-123-42"),
            Some(RemoteUidIdentity {
                account: "0123456789abcdef".into(),
                uid_validity: 123,
                uid: 42,
            })
        );
        assert_eq!(gmail_uid_from_local_id("gmail-uid-nope"), None);
        assert_eq!(gmail_uid_from_local_id("abc123@example.com"), None);
    }

    #[test]
    fn canonical_uid_identity_is_account_scoped() {
        let first = canonical_uid_id("first@example.com", 12, 34);
        let second = canonical_uid_id("second@example.com", 12, 34);
        assert_ne!(first, second);
        assert!(first.ends_with("-12-34"));
    }

    #[test]
    fn imap_search_values_are_quoted_safely() {
        assert_eq!(escape_imap_quoted("a\\\" OR ALL"), "a\\\\\\\" OR ALL");
    }

    #[test]
    fn parses_x_gm_msgid_local_ids() {
        assert_eq!(gmail_msgid_from_local_id("gmail-ff"), Some(255));
        assert_eq!(gmail_msgid_from_local_id("gmail-uid-42"), None);
        assert_eq!(gmail_msgid_from_local_id("abc123@example.com"), None);
    }

    #[test]
    fn archive_marks_deleted_then_expunges_only_the_target_uids() {
        assert_eq!(
            archive_plan(),
            [
                ArchiveCommand::StoreFlags("+FLAGS.SILENT (\\Seen \\Deleted)"),
                ArchiveCommand::UidExpunge,
            ]
        );
    }
}
