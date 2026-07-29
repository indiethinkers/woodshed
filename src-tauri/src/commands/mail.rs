// Mail commands.
//
// Every record is a markdown file in the vault. This module owns the
// on-disk shape (render/parse), the provider-agnostic disk operations
// (list, read, thread, archive-local, draft CRUD, attachments), and the
// per-message state changes. Gmail (IMAP/SMTP) is the courier; the
// provider-specific sync/send/reply live in `commands::gmail` and persist
// through the helpers here so the on-disk shape is identical.
//
// Persistence:
//   ~/woodshed/inbox/<message-id>.md    ← synced summaries (received)
//   ~/woodshed/drafts/<ulid>.md         ← user drafts
//   ~/woodshed/sent/<message-id>.md     ← record after a successful send
//   ~/woodshed/archive/<message-id>.md  ← messages user archived
//
// Read state is derived from the message's `labels` (presence of "read"
// / absence of "unread").

use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;
use ulid::Ulid;

const STORE_FILE: &str = "config.json";
const READ_LABEL: &str = "read";
const UNREAD_LABEL: &str = "unread";
const ARCHIVED_LABEL: &str = "archived";

// ─────────────────────────────────────────────────────────────────────────────
// DTOs surfaced to the frontend
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSummary {
    pub id: String,
    /// RFC 5322 Message-ID from the wire. This is distinct from `id`, which
    /// is Woodshed's account-scoped local identity for Gmail messages.
    #[serde(default)]
    pub message_id: String,
    pub thread_id: String,
    /// Sender display name; falls back to the email address when From has
    /// no display-name part.
    pub from: String,
    pub from_email: String,
    pub subject: String,
    /// Full plaintext body when available (filled by mail_get_full or by
    /// the per-message expand step in mail_sync_recent). Empty when only
    /// the list-call summary has been seen so far.
    #[serde(default)]
    pub body: String,
    /// HTML version of the body, persisted as a sibling `.html` file in
    /// the same folder as the markdown. None when the message has no
    /// HTML alternative (e.g. plaintext-only emails or messages we sent).
    #[serde(default)]
    pub html: Option<String>,
    /// First ~200 chars of body, derived locally.
    #[serde(default)]
    pub preview: String,
    /// RFC 3339.
    pub date: String,
    /// The provider's authoritative read state (Gmail `\\Seen`).
    pub read: bool,
    /// Whether the user has opened the message in Woodshed. This remains
    /// local and can be true while a provider read-state update is pending.
    #[serde(default)]
    pub viewed: bool,
    pub labels: Vec<String>,
    /// Sender slug (kebab-case) plus any other proper-name humans we
    /// could cheaply derive. Used to seed wikilink resolution against
    /// the People surface.
    pub mentions: Vec<String>,
    pub links: Vec<String>,
    /// Inbox the message belongs to (`gmail:<email>`).
    pub inbox: String,
    /// Vault-relative path to the on-disk file (e.g. `inbox/foo-x7k3a9bz.md`).
    /// Populated by `load_email_from_path` so the frontend can show the
    /// actual filename — important after a legacy → short-form migration,
    /// where the filename no longer matches the message-id. Not persisted
    /// in the markdown frontmatter; defaults to "" when constructed
    /// in-memory (e.g. before a sync's first write).
    #[serde(default)]
    pub path: String,
    /// Attachment metadata. Gmail sync extracts these from the RFC822
    /// bytes via mail-parser. Empty list when the message has none. Bytes
    /// live under `attachments/mail/<id>/`.
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

/// Attachment metadata persisted in `EmailSummary.attachments` and
/// emitted to the frontend. Bytes are NOT carried here — they live on
/// disk under `attachments/mail/<message-id>/<filename>`, written eagerly
/// during Gmail sync.
///
/// `id` is the MIME part index ("0", "1", …).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailFull {
    #[serde(flatten)]
    pub summary: EmailSummary,
    pub to: Vec<String>,
    pub cc: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailPage {
    pub items: Vec<EmailSummary>,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDto {
    pub id: String,
    pub created: String,
    pub kind: DraftKind,
    pub from_inbox: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    pub source_message_id: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DraftKind {
    New,
    Reply,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSaveInput {
    #[serde(default)]
    pub id: Option<String>,
    pub kind: DraftKind,
    #[serde(default)]
    pub from_inbox: Option<String>,
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub source_message_id: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Body bounds + derived projections
// ─────────────────────────────────────────────────────────────────────────────

const PREVIEW_CHARS: usize = 200;

fn derive_preview(body: &str) -> String {
    let cleaned = strip_preview_noise(body);
    let normalized = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(PREVIEW_CHARS).collect()
}

fn strip_preview_noise(input: &str) -> String {
    input
        .chars()
        .filter(|ch| !is_preview_ignorable_char(*ch))
        .collect()
}

fn is_preview_ignorable_char(ch: char) -> bool {
    matches!(
        ch,
        // Common invisible spacing controls used heavily in newsletter
        // HTML for layout/client quirks. They should not consume preview
        // budget or render as leaked entity text.
        '\u{00AD}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}'
    )
}

fn derive_email_preview(body: &str, html: Option<&str>, fallback: &str) -> String {
    if let Some(html) = html {
        let text = html_to_plain_text(html);
        let preview = derive_preview(&text);
        if !preview.is_empty() {
            return preview;
        }
    }
    if !body.trim().is_empty() {
        return derive_preview(&decode_html_entities(body));
    }
    derive_preview(&decode_html_entities(fallback))
}

fn html_to_plain_text(html: &str) -> String {
    let without_hidden = ["script", "style", "head"]
        .into_iter()
        .fold(html.to_string(), |acc, tag| {
            remove_html_tag_blocks(&acc, tag)
        });
    let mut out = String::with_capacity(without_hidden.len());
    let mut in_tag = false;
    for ch in without_hidden.chars() {
        match ch {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_html_entities(&out)
}

fn remove_html_tag_blocks(input: &str, tag: &str) -> String {
    let open = format!("<{}", tag);
    let close = format!("</{}", tag);
    let mut out = input.to_string();
    while let Some(start) = find_ascii_case_insensitive(&out, &open) {
        let close_start = find_ascii_case_insensitive(&out[start..], &close).map(|idx| start + idx);
        let end = close_start
            .and_then(|idx| out[idx..].find('>').map(|close_end| idx + close_end + 1))
            .or_else(|| out[start..].find('>').map(|open_end| start + open_end + 1))
            .unwrap_or(out.len());
        out.replace_range(start..end, " ");
    }
    out
}

fn find_ascii_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .to_ascii_lowercase()
        .find(&needle.to_ascii_lowercase())
}

fn decode_html_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after_amp = &rest[start + 1..];
        let Some(end) = after_amp.find(';').filter(|idx| *idx <= 32) else {
            out.push('&');
            rest = after_amp;
            continue;
        };
        let entity = &after_amp[..end];
        if !entity
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '#')
        {
            out.push('&');
            rest = after_amp;
            continue;
        }
        match decode_html_entity(entity) {
            Some(decoded) => out.push(decoded),
            None => {
                out.push('&');
                out.push_str(entity);
                out.push(';');
            }
        }
        rest = &after_amp[end + 1..];
    }
    out.push_str(rest);
    out
}

fn decode_html_entity(entity: &str) -> Option<char> {
    match entity {
        "nbsp" => Some(' '),
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" | "lsquo" | "rsquo" | "#39" => Some('\''),
        "ldquo" | "rdquo" => Some('"'),
        "ndash" | "mdash" => Some('-'),
        "shy" => Some('\u{00AD}'),
        "zwnj" => Some('\u{200C}'),
        "zwj" => Some('\u{200D}'),
        "ZeroWidthSpace" => Some('\u{200B}'),
        "NoBreak" => Some('\u{2060}'),
        _ if entity.starts_with("#x") || entity.starts_with("#X") => {
            u32::from_str_radix(&entity[2..], 16)
                .ok()
                .and_then(char::from_u32)
        }
        _ if entity.starts_with('#') => entity[1..].parse::<u32>().ok().and_then(char::from_u32),
        _ => None,
    }
}

/// Pull `https?://...` URLs out of a plaintext body. Cheap, deterministic,
/// good-enough — replaces what the LLM sidecar previously inferred.
fn extract_links(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(idx) = rest.find("http") {
        let tail = &rest[idx..];
        if !(tail.starts_with("http://") || tail.starts_with("https://")) {
            // Skip past this 'http' that's not actually a URL prefix.
            rest = &tail[4..];
            continue;
        }
        // URL ends at first whitespace or trailing punctuation.
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | ']' | '<' | '>' | '"' | '\''))
            .unwrap_or(tail.len());
        let url = tail[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
        if !url.is_empty() {
            out.push(url.to_string());
        }
        rest = &tail[end..];
    }
    out.sort();
    out.dedup();
    out
}

/// Lower-kebab the display name; used as `mentions[0]` so the sender
/// resolves to a `people/<slug>.md` if one exists.
fn kebab_slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = true;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Read-state convention: incoming mail carries an `unread` label which is
/// removed (and `read` is added) when the message is marked read. Treat
/// *missing `unread`* as the source of truth — that way we correctly drop
/// messages the user has read elsewhere that only removed `unread` without
/// adding `read`.
pub(crate) fn labels_to_read(labels: &[String]) -> bool {
    let has_read = has_label(labels, READ_LABEL);
    let has_unread = has_label(labels, UNREAD_LABEL);
    has_read || !has_unread
}

fn has_label(labels: &[String], label: &str) -> bool {
    labels.iter().any(|l| l.eq_ignore_ascii_case(label))
}

/// Message-ids round-trip RFC 2822 angle brackets (e.g.
/// `<R5MdI3PgQJSltwQdX5k14w@Geopod-Ismtpd-9>`). Those characters round-trip
/// fine through filesystems on macOS but trip URL routing, so the user sees
/// `%3CR5MdI3...%3E` breadcrumbs. Strip them at the DTO boundary so internal
/// ids are clean.
pub(crate) fn strip_brackets(s: &str) -> String {
    let trimmed = s.trim();
    let mut out = trimmed;
    if let Some(rest) = out.strip_prefix('<') {
        out = rest;
    }
    if let Some(rest) = out.strip_suffix('>') {
        out = rest;
    }
    out.to_string()
}

/// Cap on the title portion of an email filename — keeps Finder readable
/// without making the path unwieldy.
const MAX_TITLE_SLUG_LEN: usize = 40;
/// Length of the hash suffix appended after the title slug. 8 base36 chars
/// = 36^8 ≈ 2.8 trillion values; collision-safe up to ~1M messages by the
/// birthday bound. Plenty for personal use.
const SHORT_ID_LEN: usize = 8;

/// FNV-1a 64-bit hash of the message-id, formatted as 8 base36 chars.
/// Stable across Rust versions and platforms — we depend on this for
/// filename lookups, so it must be deterministic.
fn short_id(message_id: &str) -> String {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut h: u64 = FNV_OFFSET;
    for b in message_id.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    let mut buf = String::with_capacity(SHORT_ID_LEN);
    let mut n = h;
    for _ in 0..SHORT_ID_LEN {
        let r = (n % 36) as u8;
        buf.push(if r < 10 {
            (b'0' + r) as char
        } else {
            (b'a' + r - 10) as char
        });
        n /= 36;
    }
    buf
}

/// Build the filename for an email: `<title-slug>-<short-id>.md`. The
/// title slug is derived from the subject (truncated to 40 chars,
/// kebab-cased) so the inbox/ folder is grokkable in Finder. The short
/// id is a deterministic FNV-1a hash of the message_id, which is what
/// makes the filename uniquely addressable for lookups even when two
/// messages share a subject.
fn email_filename(subject: &str, message_id: &str) -> String {
    let raw = kebab_slug(subject);
    let truncated: String = raw.chars().take(MAX_TITLE_SLUG_LEN).collect();
    let slug = truncated.trim_end_matches('-');
    let sid = short_id(message_id);
    if slug.is_empty() {
        format!("{}.md", sid)
    } else {
        format!("{}-{}.md", slug, sid)
    }
}

/// Locate the markdown file for a message in `<vault>/<sub>/`. Tries
/// three forms in order:
///   1. Legacy `<message_id>.md` (pre-filename-refactor) — exact match.
///   2. New `<short_id>.md` (no subject slug) — exact match.
///   3. New `<slug>-<short_id>.md` (with subject slug) — suffix match.
///
/// Returns None when no file in that folder matches.
pub(crate) fn find_email_path(vault: &Path, sub: &str, message_id: &str) -> Option<PathBuf> {
    let dir = vault.join(sub);
    if !vault_lib::is_real_directory(&dir) {
        return None;
    }
    // Form 1: legacy long-id file written before the filename refactor.
    // We use the message_id verbatim — these files predate the short-id
    // scheme. Allows the running app to find files written by an older
    // build without forcing the user to flush + re-sync.
    if let Ok(legacy) = vault_lib::record_file_path(vault, sub, message_id) {
        if legacy.exists() {
            return Some(legacy);
        }
    }
    // Forms 2 & 3: new naming.
    let sid = short_id(message_id);
    let suffix = format!("-{}.md", sid);
    let exact = format!("{}.md", sid);
    std::fs::read_dir(&dir).ok()?.flatten().find_map(|e| {
        let path = e.path();
        if !vault_lib::is_real_file(&path) {
            return None;
        }
        let name = path.file_name()?.to_str()?;
        if name == exact || name.ends_with(&suffix) {
            Some(path)
        } else {
            None
        }
    })
}

/// Search inbox/, sent/, archive/ for a message by id. Returns the path
/// and the folder name when found.
pub(crate) fn find_email_path_anywhere<'a>(
    vault: &Path,
    message_id: &str,
) -> Option<(PathBuf, &'a str)> {
    for sub in &["inbox", "sent", "archive"] {
        if let Some(p) = find_email_path(vault, sub, message_id) {
            return Some((p, *sub));
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

/// Persist an `EmailSummary` to `inbox/<slug>-<short-id>.md`, including
/// the HTML sibling when present. Used by the Gmail sync path so the
/// on-disk shape is canonical.
///
/// Records the self-write fingerprint before each disk touch so the
/// vault watcher doesn't echo the change back to the frontend.
pub(crate) fn persist_inbox_email(
    app: &AppHandle,
    state: &State<AppState>,
    email: &EmailSummary,
    snapshot_epoch: u64,
) -> Result<Option<PathBuf>, String> {
    let vault = vault_root(app)?;
    let _guard = state.mail_mutations.lock_recover();
    let snapshot_stale = state.mail_message_mutated_after(&email.id, snapshot_epoch);
    let existing_location = find_email_path_anywhere(&vault, &email.id);
    if stale_snapshot_should_skip(
        snapshot_stale,
        existing_location.as_ref().map(|(_, folder)| *folder),
    ) {
        return Ok(None);
    }

    let mut merged = email.clone();
    if let Some((existing_path, _)) = existing_location {
        if let Some(existing) = load_email_from_path(&existing_path) {
            if snapshot_stale {
                preserve_existing_read_state(&mut merged, &existing);
            } else {
                merged.viewed = merged_viewed_state(&existing, email);
            }
        } else if snapshot_stale {
            return Ok(None);
        }
    }
    let inbox = vault_lib::ensure_vault_directory(&vault, &["inbox"])?;
    let path = vault_lib::confined_file_path(
        &vault,
        &inbox,
        &email_filename(&merged.subject, &merged.id),
    )?;
    record_self_write(state, &path);
    let md = render_email_md(&merged);
    vault_lib::write_atomic(&path, &md).map_err(|e| e.to_string())?;
    write_html_sibling(state, &path, merged.html.as_deref())?;
    upsert_email_index(app, state, &vault, &path, &merged);
    Ok(Some(path))
}

fn stale_snapshot_should_skip(snapshot_stale: bool, existing_folder: Option<&str>) -> bool {
    snapshot_stale && existing_folder != Some("inbox")
}

fn preserve_existing_read_state(incoming: &mut EmailSummary, existing: &EmailSummary) {
    incoming.read = existing.read;
    incoming.viewed = existing.viewed;
    incoming.labels.retain(|label| {
        !label.eq_ignore_ascii_case(READ_LABEL) && !label.eq_ignore_ascii_case(UNREAD_LABEL)
    });
    incoming.labels.extend(
        existing
            .labels
            .iter()
            .filter(|label| {
                label.eq_ignore_ascii_case(READ_LABEL) || label.eq_ignore_ascii_case(UNREAD_LABEL)
            })
            .cloned(),
    );
}

/// Preserve a local "already viewed" override only while Gmail continues to
/// report the same unread state. A provider read -> unread transition is an
/// explicit new attention signal and must restore the dot.
fn merged_viewed_state(existing: &EmailSummary, incoming: &EmailSummary) -> bool {
    if incoming.read {
        existing.viewed
    } else if existing.read {
        false
    } else {
        existing.viewed
    }
}

/// Directory holding the cached binary bytes for a message's attachments.
/// One sub-dir per message: `attachments/mail/<message-id>/`. Gmail writes
/// here eagerly during sync.
pub(crate) fn attachment_dir(vault: &Path, message_id: &str) -> PathBuf {
    vault
        .join("attachments")
        .join("mail")
        .join(safe_dir_component(message_id))
}

/// Make an id safe to use as a single path component. Safe ids (no path
/// separators, no `..`, no control chars, not empty) pass through unchanged
/// so existing on-disk attachment dirs keep resolving. Unsafe ids collapse
/// to a deterministic hash so a hostile `Message-ID` header can't escape
/// `attachments/mail/`.
pub(crate) fn safe_dir_component(id: &str) -> String {
    let unsafe_char = |c: char| matches!(c, '/' | '\\' | '\0') || c.is_control();
    let is_dotty = id.starts_with('.');
    if id.is_empty() || id.len() > 160 || is_dotty || id.chars().any(unsafe_char) {
        format!("id-{}", short_id(id))
    } else {
        id.to_string()
    }
}

/// Sanitize a filename pulled from an email header. Strips path
/// separators, null bytes, and leading dots so the result is always safe
/// to join onto `attachment_dir`. Falls back to a deterministic name
/// when sanitization wipes the string to empty.
pub(crate) fn sanitize_attachment_filename(raw: &str, fallback_id: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0'))
        .collect();
    // Strip leading dots so we don't accidentally produce a hidden file
    // (or `..` which can't appear after the '/' filter but better safe).
    let cleaned = cleaned.trim_start_matches('.').trim().to_string();
    if cleaned.is_empty() {
        return format!("attachment-{}.bin", safe_dir_component(fallback_id));
    }
    // Keep the complete component below both Woodshed's 200-byte policy and
    // common filesystem limits without splitting a UTF-8 codepoint.
    let mut capped = String::new();
    for ch in cleaned.chars() {
        if capped.len() + ch.len_utf8() > 160 {
            break;
        }
        capped.push(ch);
    }
    capped
}

/// Persist one attachment's bytes under `attachments/mail/<id>/`. Returns
/// the metadata record (filename, content_type, size, id) to be embedded
/// in the EmailSummary's `attachments:` array. Idempotent — if the same
/// (message_id, filename) tuple exists with matching size, the on-disk
/// bytes are left alone.
pub(crate) fn save_attachment_bytes(
    state: &State<AppState>,
    vault: &Path,
    message_id: &str,
    attachment_id: &str,
    raw_filename: &str,
    content_type: &str,
    bytes: &[u8],
) -> Result<Attachment, String> {
    let filename = sanitize_attachment_filename(raw_filename, attachment_id);
    let component = safe_dir_component(message_id);
    let dir = vault_lib::ensure_vault_directory(vault, &["attachments", "mail", &component])?;
    let path = vault_lib::confined_file_path(vault, &dir, &filename)?;
    // Skip writing if the file already exists with matching size — keeps
    // re-syncs cheap and avoids spurious watcher events.
    let should_write = match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => meta.len() != bytes.len() as u64,
        Ok(_) => {
            return Err(format!(
                "attachment path is not a regular file: {}",
                path.display()
            ))
        }
        Err(_) => true,
    };
    if should_write {
        record_self_write(state, &path);
        vault_lib::write_binary_atomic(&path, bytes)
            .map_err(|e| format!("write attachment {}: {e:#}", path.display()))?;
    }
    Ok(Attachment {
        id: attachment_id.to_string(),
        filename,
        content_type: content_type.to_string(),
        size: bytes.len() as u64,
    })
}

/// Same as `persist_inbox_email` but writes to `sent/<slug>-<short-id>.md`.
/// Used by the Gmail send path so sent mail shares the canonical on-disk
/// shape.
pub(crate) fn persist_sent_email(
    app: &AppHandle,
    state: &State<AppState>,
    email: &EmailSummary,
) -> Result<PathBuf, String> {
    let vault = vault_root(app)?;
    let sent = vault_lib::ensure_vault_directory(&vault, &["sent"])?;
    let path =
        vault_lib::confined_file_path(&vault, &sent, &email_filename(&email.subject, &email.id))?;
    record_self_write(state, &path);
    let md = render_email_md(email);
    vault_lib::write_atomic(&path, &md).map_err(|e| e.to_string())?;
    write_html_sibling(state, &path, email.html.as_deref())?;
    upsert_email_index(app, state, &vault, &path, email);
    Ok(path)
}

/// Compose an `EmailSummary` from raw parts the same way `mail_sync_recent`
/// does — derives `preview`, `links`, `mentions`, and the read-state from
/// the supplied labels. Public to the gmail module so it can produce
/// summaries without duplicating the small bits of logic.
#[allow(clippy::too_many_arguments)] // Canonical construction point for the on-disk mail DTO.
pub(crate) fn build_email_summary(
    id: String,
    message_id: String,
    thread_id: String,
    inbox: String,
    from: String,
    from_email: String,
    subject: String,
    body: String,
    html: Option<String>,
    date: String,
    labels: Vec<String>,
    attachments: Vec<Attachment>,
) -> EmailSummary {
    let preview = derive_email_preview(&body, html.as_deref(), &subject);
    let links = extract_links(&body);
    let mentions: Vec<String> = if !from.is_empty() {
        vec![kebab_slug(&from)]
    } else {
        Vec::new()
    };
    let read = labels_to_read(&labels);
    EmailSummary {
        id,
        message_id,
        thread_id,
        from,
        from_email,
        subject,
        body,
        html,
        preview,
        date,
        read,
        viewed: false,
        labels,
        mentions,
        links,
        inbox,
        path: String::new(),
        attachments,
    }
}

pub(crate) fn drafts_path(vault: &Path, id: &str) -> Result<PathBuf, String> {
    // Drafts use a ULID which is already short and filesystem-safe; no
    // title-slug treatment needed.
    vault_lib::record_file_path(vault, "drafts", id)
}

fn record_self_write(state: &State<AppState>, path: &Path) {
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(path);
    }
}

fn upsert_email_index(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    path: &Path,
    email: &EmailSummary,
) {
    let Ok(idx) = state.ensure_index(app) else {
        return;
    };
    let rel = crate::index::rel_path_str(vault, path);
    let mut indexed_email = email.clone();
    indexed_email.path = rel.clone();
    let doc = crate::index::doc_from_email(&indexed_email, &rel);
    if let Err(e) = idx.upsert_email(&doc, &indexed_email) {
        eprintln!("index email {} failed: {}", rel, e);
    }
}

fn delete_email_index(app: &AppHandle, state: &State<AppState>, vault: &Path, path: &Path) {
    let Ok(idx) = state.ensure_index(app) else {
        return;
    };
    let rel = crate::index::rel_path_str(vault, path);
    if let Err(e) = idx.delete_by_path(&rel) {
        eprintln!("delete email index {} failed: {}", rel, e);
    }
}

/// Remove a local record written under an obsolete Gmail identity after the
/// same message has been persisted under its stable identity. Everything is
/// moved to recoverable trash so migration never destroys user data.
pub(crate) fn trash_superseded_email_identity(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    obsolete_id: &str,
    expected_inbox: &str,
) {
    let Some((path, _)) = find_email_path_anywhere(vault, obsolete_id) else {
        return;
    };
    // Message-ID and X-GM-MSGID were historically used as global local IDs,
    // but neither identifies a configured account. Never migrate another
    // account's colliding record.
    if match load_email_summary_from_path(&path) {
        Some(summary) => summary.inbox != expected_inbox,
        None => true,
    } {
        return;
    }
    record_self_write(state, &path);
    trash_html_sibling(state, vault, &path);
    delete_email_index(app, state, vault, &path);
    let _ = vault_lib::move_to_trash(vault, &path);

    let attachments = attachment_dir(vault, obsolete_id);
    if vault_lib::is_real_directory(&attachments) {
        record_self_write(state, &attachments);
        let _ = vault_lib::move_to_trash(vault, &attachments);
    }
}

/// Path to the HTML sibling of an email markdown file. Same stem,
/// `.html` extension, same folder. We persist HTML alongside markdown
/// so the detail view can render rich email content while the markdown
/// stays grokkable in Finder/Obsidian.
pub(crate) fn html_sibling(md_path: &Path) -> PathBuf {
    md_path.with_extension("html")
}

/// Write the HTML sibling next to a freshly-written markdown file. No-op
/// when there's no HTML body. Always called immediately after the .md
/// write so the watcher's self-write fingerprint covers both.
fn write_html_sibling(
    state: &State<AppState>,
    md_path: &Path,
    html: Option<&str>,
) -> Result<(), String> {
    let Some(h) = html.filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let path = html_sibling(md_path);
    record_self_write(state, &path);
    vault_lib::write_atomic(&path, h).map_err(|e| e.to_string())
}

/// Move the .html sibling along with its .md file. Used by archive flows.
fn move_html_sibling(state: &State<AppState>, src_md: &Path, dst_md: &Path) -> Result<(), String> {
    let src = html_sibling(src_md);
    if !src.exists() {
        return Ok(());
    }
    let dst = html_sibling(dst_md);
    record_self_write(state, &src);
    record_self_write(state, &dst);
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())
}

/// Trash the .html sibling of an email .md file (best-effort, no error
/// if the sibling doesn't exist).
fn trash_html_sibling(state: &State<AppState>, vault: &Path, md_path: &Path) {
    let path = html_sibling(md_path);
    if path.exists() {
        record_self_write(state, &path);
        let _ = vault_lib::move_to_trash(vault, &path);
    }
}

/// Load an `EmailSummary` from a markdown file path, attaching the sibling
/// `.html` body when one is present. This is the canonical loader; every
/// call site that reads an email from disk should go through here so HTML
/// is consistently available downstream.
pub(crate) fn load_email_from_path(path: &Path) -> Option<EmailSummary> {
    let content = vault_lib::read_record(path).ok()?;
    let mut summary = parse_email_md(&content)?;
    let html_path = html_sibling(path);
    if vault_lib::is_real_file(&html_path) {
        if let Ok(html) = vault_lib::read_record(&html_path) {
            if !html.is_empty() {
                summary.preview =
                    derive_email_preview(&summary.body, Some(&html), &summary.preview);
                summary.html = Some(html);
            }
        }
    }
    // `<sub>/<filename>.md` — the same shape the frontend wants for the
    // file-path pill. We assume the path is `<vault>/<sub>/<file>` so the
    // last two components are the relative path; this is true for every
    // call site (read_inbox_dir + find_email_path_anywhere walk fixed
    // subdirs).
    attach_email_path(&mut summary, path);
    Some(summary)
}

/// List-view loader: parses only bounded YAML frontmatter and never opens the
/// HTML sibling or markdown body. New records persist their preview in
/// frontmatter so inbox rendering remains useful without eager body I/O.
pub(crate) fn load_email_summary_from_path(path: &Path) -> Option<EmailSummary> {
    let content = vault_lib::read_record_frontmatter(path).ok()?;
    let mut summary = parse_email_md(&content)?;
    summary.body.clear();
    summary.html = None;
    attach_email_path(&mut summary, path);
    Some(summary)
}

fn attach_email_path(summary: &mut EmailSummary, path: &Path) {
    if let (Some(parent), Some(file)) = (
        path.parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str()),
        path.file_name().and_then(|s| s.to_str()),
    ) {
        summary.path = format!("{}/{}", parent, file);
    }
}

/// Rename pre-refactor email files (`<full-message-id>.md`, e.g. one with
/// a Gmail-style `CAHYfh...@mail.gmail.com` name) to the current
/// `<slug>-<short-id>.md` form. The lookup code happily reads both forms,
/// so this is purely cosmetic — but raw RFC 822 message-ids in Finder are
/// hard to scan, so we self-heal at sync time. Idempotent: files already
/// in the short form (no `@` in the stem) are skipped. Renames the
/// `.html` sibling alongside so the pair stays linked.
pub(crate) fn migrate_legacy_filenames(
    vault: &Path,
    state: &State<AppState>,
) -> Result<(), String> {
    for sub in &["inbox", "sent", "archive"] {
        let dir = vault.join(sub);
        if !vault_lib::is_real_directory(&dir) {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md")
                || !vault_lib::is_real_file(&path)
            {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            // Heuristic: a raw RFC 822 message-id always contains `@host`;
            // the new short-form names never do.
            if !stem.contains('@') {
                continue;
            }
            let summary = match vault_lib::read_record_frontmatter(&path)
                .ok()
                .as_deref()
                .and_then(parse_email_md)
            {
                Some(s) => s,
                None => continue,
            };
            let new_path = dir.join(email_filename(&summary.subject, &summary.id));
            if new_path == path || new_path.exists() {
                continue;
            }
            record_self_write(state, &path);
            record_self_write(state, &new_path);
            if std::fs::rename(&path, &new_path).is_err() {
                continue;
            }
            // Best-effort: keep the html sibling next to the markdown.
            let _ = move_html_sibling(state, &path, &new_path);
        }
    }
    Ok(())
}

/// Account-scope thread ids written by older builds. The migration edits only
/// the `thread:` frontmatter line, preserving bodies and any unknown fields.
/// It is idempotent and runs before the startup index decision so changed
/// grouping keys are re-indexed as one unit.
pub(crate) fn migrate_gmail_thread_ids(vault: &Path) -> Result<usize, String> {
    let mut changed = 0;
    for sub in ["inbox", "sent", "archive"] {
        let dir = vault.join(sub);
        if !vault_lib::is_real_directory(&dir) {
            continue;
        }
        let entries = std::fs::read_dir(&dir)
            .map_err(|error| format!("read {sub} for mail migration: {error}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md")
                || !vault_lib::is_real_file(&path)
            {
                continue;
            }
            let content = match vault_lib::read_record(&path) {
                Ok(content) => content,
                Err(_) => continue,
            };
            let Some(updated) = scope_gmail_thread_frontmatter(&content) else {
                continue;
            };
            vault_lib::write_atomic(&path, &updated)
                .map_err(|error| format!("write account-scoped mail thread metadata: {error}"))?;
            changed += 1;
        }
    }
    Ok(changed)
}

fn scope_gmail_thread_frontmatter(content: &str) -> Option<String> {
    let frontmatter = content.find("\n---\n").map(|end| &content[..end + 5])?;
    let summary = parse_email_md(frontmatter)?;
    let account_email = crate::commands::gmail::email_from_inbox_id(&summary.inbox)?;
    let scoped =
        crate::commands::gmail::account_scoped_thread_id(account_email, &summary.thread_id);
    if scoped == summary.thread_id {
        return None;
    }
    let old_line = frontmatter
        .lines()
        .find(|line| line.starts_with("thread: "))?;
    let new_line = format!("thread: {}", json_string(&scoped));
    Some(content.replacen(old_line, &new_line, 1))
}

#[tauri::command]
pub fn mail_inbox_page(
    app: AppHandle,
    state: State<'_, AppState>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<MailPage, String> {
    let _vault = vault_root(&app)?;
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(200).clamp(1, 200);
    let (items, next_offset) = state
        .ensure_index(&app)?
        .mail_inbox_page(offset, limit)
        .map_err(|error| error.to_string())?;
    Ok(MailPage { items, next_offset })
}

#[tauri::command]
pub fn mail_get_local(app: AppHandle, id: String) -> Result<Option<EmailSummary>, String> {
    let vault = vault_root(&app)?;
    // Tolerate URLs that still carry the legacy bracketed form
    // `<id@host>` — we strip on persistence so the disk filename is
    // bracket-free, but a router that left the URL bracketed would
    // otherwise miss the file.
    let id = strip_brackets(&id);
    mail_get_local_inner(&vault, &id)
}

pub(crate) fn read_inbox_dir(dir: &Path) -> Vec<EmailSummary> {
    if !vault_lib::is_real_directory(dir) {
        return Vec::new();
    }
    let mut out: Vec<EmailSummary> = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let path = entry.path();
            path.extension().and_then(|s| s.to_str()) == Some("md")
                && vault_lib::is_real_file(&path)
        })
        .filter_map(|entry| load_email_summary_from_path(&entry.path()))
        .collect();
    out.sort_by(|a, b| email_date_cmp(b, a));
    out
}

/// Compare two emails by their `date` field as actual instants, not
/// lexicographically. Required because sent messages persist with the
/// local timezone offset (`…-04:00`) while received messages can carry
/// UTC (`…Z`) — string compare would order `16:37-04:00`
/// before `20:07Z` even though they refer to the same calendar order.
/// Falls back to string compare when a date doesn't parse so a single
/// malformed file can't take down the sort.
pub(crate) fn email_date_cmp(a: &EmailSummary, b: &EmailSummary) -> std::cmp::Ordering {
    let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).ok();
    match (parse(&a.date), parse(&b.date)) {
        (Some(da), Some(db)) => da.cmp(&db),
        _ => a.date.cmp(&b.date),
    }
}

/// Return the full message (summary + to/cc) for `id`. Gmail sync stores
/// the full body and attachments locally, so this reads straight from disk.
/// `to`/`cc` aren't persisted in the local summary and come back empty —
/// the detail view already has the sender from the summary.
#[tauri::command]
pub fn mail_get_full(app: AppHandle, id: String) -> Result<EmailFull, String> {
    let id = strip_brackets(&id);
    let vault = vault_root(&app)?;
    mail_get_local_inner(&vault, &id)?
        .map(email_full_from_local)
        .ok_or_else(|| format!("message {} not on disk", id))
}

fn email_full_from_local(summary: EmailSummary) -> EmailFull {
    EmailFull {
        summary,
        to: Vec::new(),
        cc: Vec::new(),
    }
}

/// Resolve a known attachment beneath its message directory and open it with
/// the OS default application. The frontend never receives an arbitrary path.
#[tauri::command]
pub fn mail_open_attachment(
    app: AppHandle,
    message_id: String,
    attachment_id: String,
) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let local = mail_get_local_inner(&vault, &message_id)?
        .ok_or_else(|| format!("message {} not on disk", message_id))?;
    let meta = local
        .attachments
        .iter()
        .find(|a| a.id == attachment_id)
        .cloned()
        .ok_or_else(|| {
            format!(
                "attachment {} not found on message {}",
                attachment_id, message_id
            )
        })?;
    let safe_filename = sanitize_attachment_filename(&meta.filename, &meta.id);
    if safe_filename != meta.filename {
        return Err("attachment metadata contains an unsafe filename".to_string());
    }
    let dir = attachment_dir(&vault, &message_id);
    if !vault_lib::is_real_directory(&vault.join("attachments"))
        || !vault_lib::is_real_directory(&vault.join("attachments").join("mail"))
        || !vault_lib::is_real_directory(&dir)
    {
        return Err("attachment directory is missing or unsafe".to_string());
    }
    let path = vault_lib::confined_file_path(&vault, &dir, &safe_filename)?;
    if !vault_lib::is_real_file(&path) {
        return Err(format!(
            "attachment missing from disk: {}. Re-sync this account to refetch.",
            path.display()
        ));
    }
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("resolve attachment directory: {e}"))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("resolve attachment: {e}"))?;
    if canonical_path.parent() != Some(canonical_dir.as_path()) {
        return Err("attachment path escapes its message directory".to_string());
    }
    super::vault::open_path(&canonical_path)
}

pub(crate) fn mail_get_local_inner(vault: &Path, id: &str) -> Result<Option<EmailSummary>, String> {
    let id = strip_brackets(id);
    if let Some((path, _)) = find_email_path_anywhere(vault, &id) {
        return Ok(load_email_from_path(&path));
    }
    Ok(None)
}

// Send / reply live in `commands::gmail` (lettre + SMTP); both persist the
// sent copy through `persist_sent_email` here so `sent/` shares the canonical
// on-disk shape.

// ─────────────────────────────────────────────────────────────────────────────
// Drafts (vault-resident)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn mail_draft_save(
    app: AppHandle,
    state: State<'_, AppState>,
    input: DraftSaveInput,
) -> Result<DraftDto, String> {
    let vault = vault_root(&app)?;
    std::fs::create_dir_all(vault.join("drafts")).map_err(|e| e.to_string())?;

    let id = input.id.unwrap_or_else(|| Ulid::new().to_string());
    let created = chrono::Local::now().to_rfc3339();
    let dto = DraftDto {
        id: id.clone(),
        created,
        kind: input.kind,
        from_inbox: input.from_inbox,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.body,
        source_message_id: input.source_message_id,
        thread_id: input.thread_id,
    };
    let path = drafts_path(&vault, &id)?;
    record_self_write(&state, &path);
    vault_lib::write_atomic(&path, &render_draft_md(&dto)).map_err(|e| e.to_string())?;
    Ok(dto)
}

#[tauri::command]
pub fn mail_draft_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let path = drafts_path(&vault, &id)?;
    record_self_write(&state, &path);
    if path.exists() {
        vault_lib::move_to_trash(&vault, &path)?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-message state changes (mark-read / archive / delete) + thread fetch
// ─────────────────────────────────────────────────────────────────────────────

fn persist_mark_read_state(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    updated: &EmailSummary,
) -> Result<(), String> {
    let _guard = state.mail_mutations.lock_recover();
    let Some((path, _)) = find_email_path_anywhere(vault, &updated.id) else {
        return Ok(());
    };
    let Some(mut current) = load_email_from_path(&path) else {
        return Ok(());
    };

    current.viewed = updated.viewed;
    if updated.read {
        current.read = true;
        current.labels = updated.labels.clone();
    }

    record_self_write(state, &path);
    vault_lib::write_atomic(&path, &render_email_md(&current))
        .map_err(|error| error.to_string())?;
    upsert_email_index(app, state, vault, &path, &current);
    Ok(())
}

/// Persist the local viewed state before asking the provider to mark the
/// message read. A provider failure therefore remains visible to the caller
/// without making an email the user already opened look unread again.
async fn mark_read_with_provider<Persist, MarkSeen, MarkSeenFuture>(
    summary: &mut EmailSummary,
    mut persist: Persist,
    mark_seen: MarkSeen,
) -> Result<(), String>
where
    Persist: FnMut(&EmailSummary) -> Result<(), String>,
    MarkSeen: FnOnce() -> MarkSeenFuture,
    MarkSeenFuture: Future<Output = Result<(), String>>,
{
    summary.viewed = true;
    persist(summary)?;

    if labels_to_read(&summary.labels) {
        return Ok(());
    }

    mark_seen()
        .await
        .map_err(|error| format!("provider_read_failed: {error}"))?;

    summary
        .labels
        .retain(|label| !label.eq_ignore_ascii_case(UNREAD_LABEL));
    if !summary
        .labels
        .iter()
        .any(|label| label.eq_ignore_ascii_case(READ_LABEL))
    {
        summary.labels.push(READ_LABEL.to_string());
    }
    summary.read = true;
    persist(summary).map_err(|error| format!("viewed_persisted: {error}"))
}

/// Mark a single message viewed locally, then synchronize Gmail `\Seen` via
/// IMAP STORE. Calling it on a provider-read message only persists `viewed`.
#[tauri::command]
pub async fn mail_mark_read(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let id = strip_brackets(&id);
    let vault = vault_root(&app)?;
    let Some(mut summary) = mail_get_local_inner(&vault, &id)? else {
        return Ok(()); // file isn't on disk; nothing to mark
    };
    let gmail_email =
        crate::commands::gmail::email_from_inbox_id(&summary.inbox).map(str::to_owned);
    let message_id = summary.id.clone();

    mark_read_with_provider(
        &mut summary,
        |updated| persist_mark_read_state(&app, &state, &vault, updated),
        || async {
            // Gmail messages flip `\Seen` via IMAP STORE (per-account
            // credentials). Legacy/local records update their labels locally.
            let Some(gmail_email) = gmail_email.as_deref() else {
                return Ok(());
            };
            let creds = crate::commands::gmail::resolve_credentials(&app, &state, gmail_email)?;
            let pool = state.gmail_pool.clone();
            let seen_message_id = message_id.clone();
            tokio::task::spawn_blocking(move || {
                crate::gmail::imap_client::mark_seen(&pool, &creds, &seen_message_id)
            })
            .await
            .map_err(|error| format!("imap thread: {error}"))?
            .map_err(|error| error.to_string())?;
            state.record_mail_provider_mutation(&message_id);
            Ok(())
        },
    )
    .await
}

/// Archive one message: remove it from the Gmail INBOX (also marks read),
/// then rewrite + move the local file from `inbox/<id>.md` to
/// `archive/<id>.md`.
#[tauri::command]
pub async fn mail_archive_one(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let id = strip_brackets(&id);
    let vault = vault_root(&app)?;
    let Some((_, folder)) = find_email_path_anywhere(&vault, &id) else {
        return Err(format!("message {} not found locally", id));
    };
    // Archive is idempotent. A detail thread spans inbox/, sent/, and
    // archive/, and a repeated click can arrive after the first command has
    // already moved the file. Only inbox membership needs changing; sent and
    // archived records are already outside Gmail's INBOX.
    if folder != "inbox" {
        return Ok(());
    }
    let Some(mut summary) = mail_get_local_inner(&vault, &id)? else {
        return Err(format!("message {} not found locally", id));
    };

    archive_remote_email(&app, &state, &summary).await?;
    archive_local_email(&app, &state, &vault, &mut summary)?;
    Ok(())
}

/// Remove a message from the provider's inbox. Gmail removes the INBOX
/// label via IMAP (which also marks it read). Records with no recognized
/// provider (legacy/orphan) have no remote to update — the local move
/// in `archive_local_email` is all there is.
async fn archive_remote_email(
    app: &AppHandle,
    state: &State<'_, AppState>,
    email: &EmailSummary,
) -> Result<(), String> {
    if let Some(gmail_email) = crate::commands::gmail::email_from_inbox_id(&email.inbox) {
        let creds = crate::commands::gmail::resolve_credentials(app, state, gmail_email)?;
        let pool = state.gmail_pool.clone();
        let mid = email.id.clone();
        tokio::task::spawn_blocking(move || {
            crate::gmail::imap_client::archive_message(&pool, &creds, &mid)
        })
        .await
        .map_err(|e| format!("imap thread: {e}"))?
        .map_err(|e| e.to_string())?;
        state.record_mail_provider_mutation(&email.id);
        return Ok(());
    }
    Ok(())
}

fn archive_local_email(
    app: &AppHandle,
    state: &State<'_, AppState>,
    vault: &Path,
    email: &mut EmailSummary,
) -> Result<(), String> {
    let _guard = state.mail_mutations.lock_recover();
    let Some((src, folder)) = find_email_path_anywhere(vault, &email.id) else {
        return Ok(());
    };
    if folder != "inbox" {
        return Ok(());
    }
    let Some(current) = load_email_from_path(&src) else {
        return Ok(());
    };
    *email = current;

    email
        .labels
        .retain(|l| !l.eq_ignore_ascii_case(UNREAD_LABEL));
    for tag in [ARCHIVED_LABEL, READ_LABEL] {
        if !email.labels.iter().any(|l| l.eq_ignore_ascii_case(tag)) {
            email.labels.push(tag.to_string());
        }
    }
    email.read = true;

    let archive_dir = vault_lib::ensure_vault_directory(vault, &["archive"])?;
    let dst = vault_lib::confined_file_path(
        vault,
        &archive_dir,
        &email_filename(&email.subject, &email.id),
    )?;
    record_self_write(state, &src);
    record_self_write(state, &dst);
    vault_lib::write_atomic(&dst, &render_email_md(email)).map_err(|e| e.to_string())?;
    upsert_email_index(app, state, vault, &dst, email);
    if src != dst {
        move_html_sibling(state, &src, &dst)?;
        delete_email_index(app, state, vault, &src);
        let _ = std::fs::remove_file(&src);
    }
    Ok(())
}

/// Reconcile a Gmail account's local inbox against the live Gmail INBOX.
///
/// The sync path only ever *adds* to `inbox/`; without this, a message the
/// user archived or handled directly in Gmail lingers locally forever and
/// keeps showing up in the sweep's Review lane. Here we pull the full set
/// of message ids currently in the Gmail inbox and archive-locally (move
/// to `archive/`) any local inbox file for this account that's no longer
/// among them. Gmail is the source of truth for inbox membership.
///
/// Returns the count archived. The id set is the *full* inbox (not the
/// recent-N sync window), so messages outside the sync window aren't
/// wrongly evicted. Both sides are normalized through `strip_brackets`.
pub(crate) async fn reconcile_gmail_inbox(
    app: &AppHandle,
    state: &State<'_, AppState>,
    vault: &Path,
    inbox_id: &str,
    creds: &crate::gmail::creds::Credentials,
    just_synced: &[String],
) -> Result<usize, String> {
    let pool = state.gmail_pool.clone();
    let creds = creds.clone();
    let live_raw = tokio::task::spawn_blocking(move || {
        crate::gmail::imap_client::fetch_inbox_ids(&pool, &creds)
    })
    .await
    .map_err(|e| format!("reconcile thread panicked: {e}"))?
    .map_err(|e| e.to_string())?;

    // Normalize the live set the same way we normalize each local id, so
    // bracket form / whitespace can't cause a false "not present" verdict
    // (which would wrongly archive a message that's actually still there).
    let mut live: std::collections::HashSet<String> =
        live_raw.iter().map(|s| strip_brackets(s)).collect();
    // Belt-and-suspenders: never reconcile away a message we just pulled
    // from the Gmail inbox this pass, even if its ENVELOPE Message-ID
    // normalizes slightly differently from the persisted one.
    live.extend(just_synced.iter().map(|s| strip_brackets(s)));

    let mut archived = 0usize;
    for mut summary in read_inbox_dir(&vault.join("inbox")) {
        if summary.inbox.as_str() != inbox_id {
            continue;
        }
        if live.contains(&strip_brackets(&summary.id)) {
            continue;
        }
        match archive_local_email(app, state, vault, &mut summary) {
            Ok(()) => archived += 1,
            Err(e) => eprintln!("gmail reconcile: archive {} failed: {e}", summary.id),
        }
    }
    Ok(archived)
}

/// Delete one message's local file. Searches inbox/, sent/, and archive/.
///
/// For files still in `inbox/`, we also mark the Gmail message read (IMAP
/// `\Seen`) before local removal. Without this the next sync would pull the
/// unread message right back. Files in `archive/` or `sent/` are already
/// non-unread on the provider side, so we just remove the local file.
#[tauri::command]
pub async fn mail_delete_one(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let id = strip_brackets(&id);
    let vault = vault_root(&app)?;

    // Find which folder the file lives in and resolve the provider metadata
    // we'll need for the remote "don't re-sync this as unread" update.
    let (path, sub) = find_email_path_anywhere(&vault, &id)
        .ok_or_else(|| format!("message {} not found locally", id))?;
    let in_inbox = sub == "inbox";
    let summary_for_patch = load_email_from_path(&path);

    if in_inbox {
        if let Some(summary) = summary_for_patch {
            // Mark read on Gmail so the next sync doesn't pull it back. Do
            // not delete locally if this fails. Records with no recognized
            // provider (legacy/orphan) skip the remote step.
            if let Some(gmail_email) = crate::commands::gmail::email_from_inbox_id(&summary.inbox) {
                let creds = crate::commands::gmail::resolve_credentials(&app, &state, gmail_email)?;
                let pool = state.gmail_pool.clone();
                let mid = summary.id.clone();
                tokio::task::spawn_blocking(move || {
                    crate::gmail::imap_client::mark_seen(&pool, &creds, &mid)
                })
                .await
                .map_err(|e| format!("imap thread: {e}"))?
                .map_err(|e| e.to_string())?;
                state.record_mail_provider_mutation(&summary.id);
            }
        }
    }

    let _guard = state.mail_mutations.lock_recover();
    let Some((path, _)) = find_email_path_anywhere(&vault, &id) else {
        return Ok(());
    };
    record_self_write(&state, &path);
    delete_email_index(&app, &state, &vault, &path);
    vault_lib::move_to_trash(&vault, &path)?;
    trash_html_sibling(&state, &vault, &path);
    Ok(())
}

/// Return every locally-persisted message that shares `thread_id`, sorted
/// oldest-first. Walks inbox/, sent/, and archive/ so a thread that spans
/// folders (received → archived → reply) renders as a single conversation
/// in the detail view.
#[tauri::command]
pub fn mail_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<EmailSummary>, String> {
    let thread_id = strip_brackets(&thread_id);
    let vault = vault_root(&app)?;
    let mut out: Vec<EmailSummary> = Vec::new();
    let index = state.ensure_index(&app)?;
    for relative in index
        .mail_thread_paths(&thread_id)
        .map_err(|error| error.to_string())?
    {
        let mut components = Path::new(&relative).components();
        let Some(std::path::Component::Normal(sub)) = components.next() else {
            continue;
        };
        let Some(std::path::Component::Normal(filename)) = components.next() else {
            continue;
        };
        if components.next().is_some()
            || !matches!(sub.to_str(), Some("inbox" | "sent" | "archive"))
        {
            continue;
        }
        let Some(filename) = filename.to_str() else {
            continue;
        };
        let dir = vault.join(sub);
        let Ok(path) = vault_lib::confined_file_path(&vault, &dir, filename) else {
            continue;
        };
        if let Some(summary) = load_email_from_path(&path) {
            out.push(summary);
        }
    }
    out.sort_by(email_date_cmp);
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown render / parse
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn render_email_md(email: &EmailSummary) -> String {
    let labels = comma_join(&email.labels);
    let mentions = comma_join(&email.mentions);
    let links = comma_join(&email.links);
    let attachments = render_attachments_yaml(&email.attachments);
    // Always quote machine identifiers (id, thread, inbox, from_email).
    // Message-ids contain `=`, `@`, `+`, `/` — chars that are valid in
    // unquoted YAML scalars but trigger edge cases in some parsers. The
    // tiny size cost of quoting is well worth never having to debug a
    // YAML round-trip miss again.
    format!(
        "---\n\
         type: email\n\
         id: {id}\n\
         message_id: {message_id}\n\
         thread: {thread}\n\
         inbox: {inbox}\n\
         from: {from}\n\
         from_email: {from_email}\n\
         subject: {subject}\n\
         preview: {preview}\n\
         date: {date}\n\
         read: {read}\n\
         viewed: {viewed}\n\
         labels: [{labels}]\n\
         mentions: [{mentions}]\n\
         links: [{links}]\n\
{attachments}\
         ---\n\n{body}\n",
        id = json_string(&email.id),
        message_id = json_string(&email.message_id),
        thread = json_string(&email.thread_id),
        inbox = json_string(&email.inbox),
        from = yaml_string(&email.from),
        from_email = json_string(&email.from_email),
        subject = yaml_string(&email.subject),
        preview = yaml_string(&email.preview),
        date = email.date,
        read = email.read,
        viewed = email.viewed,
        labels = labels,
        mentions = mentions,
        links = links,
        attachments = attachments,
        body = email.body,
    )
}

/// Emit the `attachments:` YAML block. Empty list collapses to nothing
/// so messages without attachments stay byte-identical to the pre-feature
/// shape. Each entry is a block-style map for readability. Rust's
/// `"...\n\<newline><indent>"` continuation strips the indent at parse
/// time, so the surrounding `render_email_md` format string contains no
/// leading whitespace at runtime — we match that here.
fn render_attachments_yaml(items: &[Attachment]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut s = String::from("attachments:\n");
    for a in items {
        s.push_str(&format!(
            "  - id: {id}\n    filename: {filename}\n    content_type: {ct}\n    size: {size}\n",
            id = json_string(&a.id),
            filename = yaml_string(&a.filename),
            ct = yaml_string(&a.content_type),
            size = a.size,
        ));
    }
    s
}

pub(crate) fn render_draft_md(d: &DraftDto) -> String {
    format!(
        "---\n\
         type: draft\n\
         id: {id}\n\
         kind: {kind}\n\
         created: {created}\n\
         from_inbox: {from}\n\
         to: [{to}]\n\
         cc: [{cc}]\n\
         bcc: [{bcc}]\n\
         subject: {subject}\n\
         source_message_id: {source}\n\
         thread_id: {thread}\n\
         ---\n\n{body}\n",
        id = d.id,
        kind = match d.kind {
            DraftKind::New => "new",
            DraftKind::Reply => "reply",
        },
        created = d.created,
        from = d.from_inbox.clone().unwrap_or_default(),
        to = comma_join(&d.to),
        cc = comma_join(&d.cc),
        bcc = comma_join(&d.bcc),
        subject = yaml_string(&d.subject),
        source = d.source_message_id.clone().unwrap_or_default(),
        thread = d.thread_id.clone().unwrap_or_default(),
        body = d.body,
    )
}

fn parse_email_md(content: &str) -> Option<EmailSummary> {
    parse_email_md_yaml(content).or_else(|| {
        let repaired = repair_legacy_misquoted_sender(content)?;
        parse_email_md_yaml(&repaired)
    })
}

fn parse_email_md_yaml(content: &str) -> Option<EmailSummary> {
    use gray_matter::{engine::YAML, Matter};
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed.data?;
    let map = data.as_hashmap().ok()?;

    let id = map.get("id")?.as_string().ok()?;
    let message_id = map
        .get("message_id")
        .and_then(|value| value.as_string().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| id.clone());
    let thread = map.get("thread")?.as_string().ok()?;
    // Tolerate older files that used `account:` before the rename to `inbox:`.
    let inbox = map
        .get("inbox")
        .or_else(|| map.get("account"))
        .and_then(|v| v.as_string().ok())?;
    let from = map.get("from")?.as_string().ok()?;
    let from_email = map.get("from_email")?.as_string().ok()?;
    let subject = map.get("subject")?.as_string().ok()?;
    let date = map.get("date")?.as_string().ok()?;
    let read = map
        .get("read")
        .and_then(|v| v.as_bool().ok())
        .unwrap_or(false);
    let viewed = map
        .get("viewed")
        .and_then(|value| value.as_bool().ok())
        .unwrap_or(false);
    let labels = pod_string_array(map.get("labels"));
    let mentions = pod_string_array(map.get("mentions"));
    let links = pod_string_array(map.get("links"));
    let attachments = pod_attachments(map.get("attachments"));

    let body = parsed.content.trim().to_string();
    let preview = map
        .get("preview")
        .and_then(|value| value.as_string().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| derive_preview(&decode_html_entities(&body)));
    Some(EmailSummary {
        id,
        message_id,
        thread_id: thread,
        from,
        from_email,
        subject,
        body,
        html: None,
        preview,
        date,
        read,
        viewed,
        labels,
        mentions,
        links,
        inbox,
        path: String::new(),
        attachments,
    })
}

/// Older writers only quoted strings containing a small punctuation set.
/// A sender with a quoted display name followed by relay metadata therefore
/// produced invalid YAML: the leading quote closes before the trailing text.
/// Repair that one historical shape on read so already-written mail remains
/// usable; new writes quote every string through `yaml_string` below.
fn repair_legacy_misquoted_sender(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()? != "---" {
        return None;
    }
    for line in lines {
        if line == "---" {
            break;
        }
        let Some(value) = line.strip_prefix("from: ").map(str::trim) else {
            continue;
        };
        let quote = value.chars().next()?;
        if !matches!(quote, '\'' | '"') || value.ends_with(quote) {
            return None;
        }
        let repaired = format!("from: {}", json_string(value));
        return Some(content.replacen(line, &repaired, 1));
    }
    None
}

fn pod_string_array(opt: Option<&gray_matter::Pod>) -> Vec<String> {
    let Some(pod) = opt else { return Vec::new() };
    let Ok(items) = pod.as_vec() else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|p| p.as_string().ok())
        .collect()
}

/// Parse the `attachments:` YAML block into Attachment records. Empty
/// list for absent, malformed, or partial entries — never panics. Drops
/// entries missing `id` or `filename` (the two fields we can't synthesize).
fn pod_attachments(opt: Option<&gray_matter::Pod>) -> Vec<Attachment> {
    let Some(pod) = opt else { return Vec::new() };
    let Ok(items) = pod.as_vec() else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| {
            let map = item.as_hashmap().ok()?;
            let id = map.get("id").and_then(|p| p.as_string().ok())?;
            let filename = map.get("filename").and_then(|p| p.as_string().ok())?;
            let content_type = map
                .get("content_type")
                .and_then(|p| p.as_string().ok())
                .unwrap_or_default();
            let size = map
                .get("size")
                .and_then(|p| p.as_i64().ok())
                .unwrap_or(0)
                .max(0) as u64;
            Some(Attachment {
                id,
                filename,
                content_type,
                size,
            })
        })
        .collect()
}

// ─── Tiny YAML helpers ──────────────────────────────────────────────────────

fn yaml_string(s: &str) -> String {
    json_string(s)
}

/// Always-quoted JSON-style string, used for machine identifiers in YAML
/// frontmatter. JSON strings are valid YAML strings, and quoting unconditionally
/// avoids every YAML plain-scalar edge case at minimal cost.
fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn comma_join(v: &[String]) -> String {
    v.iter()
        .map(|s| format!("\"{}\"", s.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Ensure the rendered HTML for `id` is on disk before the iframe asks
/// for it. Cheap on cache hit (a single stat), pays the render cost
/// once on miss: locate the source `.html` sibling in the vault, look
/// up cached image dimensions for every referenced URL, run
/// `email_render::render_email` with that map (so the renderer can
/// emit `width`/`height` attrs on `<img>` and email layout doesn't
/// shift as images load), then write to the rendered cache. After
/// this returns, the wsmail:// `/body/<id>` request resolves from
/// disk.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailBodyRenderResult {
    cache_id: String,
    has_remote_images: bool,
}

const EMAIL_BODY_RENDER_CACHE_VERSION: u8 = 2;

fn email_body_cache_id(id: &str, load_remote_images: bool) -> String {
    let mode = if load_remote_images {
        "remote-images"
    } else {
        "images-blocked"
    };
    format!("{id}:{mode}:v{EMAIL_BODY_RENDER_CACHE_VERSION}")
}

#[tauri::command]
pub async fn email_body_render(
    app: AppHandle,
    id: String,
    load_remote_images: bool,
) -> Result<EmailBodyRenderResult, String> {
    let cache_id = email_body_cache_id(&id, load_remote_images);
    let vault = vault_root(&app)?;
    let (md_path, _sub) =
        find_email_path_anywhere(&vault, &id).ok_or_else(|| format!("email not found: {id}"))?;
    let html_path = html_sibling(&md_path);
    if !vault_lib::is_real_file(&html_path) {
        return Err(format!(
            "email HTML is missing or is not a regular file: {id}"
        ));
    }
    let metadata = std::fs::metadata(&html_path)
        .map_err(|e| format!("inspect {}: {e}", html_path.display()))?;
    if metadata.len() > 16 * 1024 * 1024 {
        return Err("email HTML exceeds 16 MiB".to_string());
    }
    let raw = vault_lib::read_record(&html_path)
        .map_err(|e| format!("read {}: {e}", html_path.display()))?;
    if raw.is_empty() {
        return Err(format!("empty .html for {id}"));
    }

    // Look up cached image dimensions before rendering so the renderer
    // can attach `width`/`height` attrs. Images that aren't in the
    // cache yet (or whose bytes can't be decoded) fall through with
    // no entry — the renderer just omits the attrs for those.
    let urls = crate::email_render::extract_remote_image_urls(&raw);
    let has_remote_images = !urls.is_empty();
    if crate::image_cache::read_rendered_body(&app, &cache_id)
        .await?
        .is_some()
    {
        return Ok(EmailBodyRenderResult {
            cache_id,
            has_remote_images,
        });
    }
    if load_remote_images {
        crate::image_cache::prefetch_all(&app, urls.clone()).await;
    }
    let mut dimensions = std::collections::HashMap::new();
    for url in urls {
        if dimensions.contains_key(&url) {
            continue;
        }
        if let Some(dim) = crate::image_cache::lookup_dimensions(&app, &url).await {
            dimensions.insert(url, dim);
        }
    }

    let rendered = crate::email_render::render_email(&raw, dimensions, load_remote_images)?;
    crate::image_cache::write_rendered_body(&app, &cache_id, &rendered).await?;
    Ok(EmailBodyRenderResult {
        cache_id,
        has_remote_images,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_email_cache_ids_include_the_renderer_version() {
        assert_eq!(
            email_body_cache_id("message-1", true),
            "message-1:remote-images:v2"
        );
        assert_eq!(
            email_body_cache_id("message-1", false),
            "message-1:images-blocked:v2"
        );
    }

    fn sample_email() -> EmailSummary {
        let body = "Hey — wanna grab lunch?\n\nWas thinking 12:30 at https://joes.example.com."
            .to_string();
        let preview = derive_preview(&body);
        EmailSummary {
            id: "abc123".into(),
            message_id: "abc123@example.test".into(),
            thread_id: "thread-1".into(),
            from: "Alex Rivera".into(),
            from_email: "alex@example.com".into(),
            subject: "Lunch tomorrow?".into(),
            body,
            html: None,
            preview,
            date: "2026-04-25T10:30:00-04:00".into(),
            read: false,
            viewed: false,
            labels: vec!["inbox".into(), "unread".into()],
            mentions: vec!["alex-rivera".into()],
            links: vec!["https://joes.example.com".into()],
            inbox: "inbox_personal".into(),
            path: String::new(),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn render_email_md_roundtrips() {
        let original = sample_email();
        let md = render_email_md(&original);
        let parsed = parse_email_md(&md).expect("parse roundtrip");
        assert_eq!(parsed.id, original.id);
        assert_eq!(parsed.message_id, original.message_id);
        assert_eq!(parsed.thread_id, original.thread_id);
        assert_eq!(parsed.inbox, original.inbox);
        assert_eq!(parsed.from, original.from);
        assert_eq!(parsed.from_email, original.from_email);
        assert_eq!(parsed.subject, original.subject);
        assert_eq!(parsed.body, original.body);
        assert_eq!(parsed.preview, original.preview);
        assert_eq!(parsed.date, original.date);
        assert_eq!(parsed.read, original.read);
        assert_eq!(parsed.viewed, original.viewed);
        assert_eq!(parsed.labels, original.labels);
        assert_eq!(parsed.mentions, original.mentions);
        assert_eq!(parsed.links, original.links);
    }

    #[tokio::test]
    async fn remote_read_failure_keeps_local_viewed_without_claiming_provider_seen() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("synthetic-message.md");
        let mut email = sample_email();
        vault_lib::write_atomic(&path, &render_email_md(&email)).unwrap();

        let result = mark_read_with_provider(
            &mut email,
            |updated| {
                vault_lib::write_atomic(&path, &render_email_md(updated))
                    .map_err(|error| error.to_string())
            },
            || async { Err("synthetic provider failure".to_string()) },
        )
        .await;

        assert!(result
            .unwrap_err()
            .contains("provider_read_failed: synthetic provider failure"));
        let reloaded = load_email_from_path(&path).expect("reload locally viewed message");
        assert!(reloaded.viewed);
        assert!(!reloaded.read);
        assert!(reloaded
            .labels
            .iter()
            .any(|label| label.eq_ignore_ascii_case(UNREAD_LABEL)));
    }

    #[tokio::test]
    async fn local_view_failure_stops_before_provider_sync() {
        let provider_called = std::cell::Cell::new(false);
        let mut email = sample_email();

        let result = mark_read_with_provider(
            &mut email,
            |_| Err("synthetic local persistence failure".to_string()),
            || async {
                provider_called.set(true);
                Ok(())
            },
        )
        .await;

        assert_eq!(result.unwrap_err(), "synthetic local persistence failure");
        assert!(!provider_called.get());
    }

    #[test]
    fn provider_sync_preserves_viewed_only_while_message_stays_unread() {
        let mut existing = sample_email();
        existing.viewed = true;

        let still_unread = sample_email();
        assert!(merged_viewed_state(&existing, &still_unread));

        existing.read = true;
        existing.labels = vec!["inbox".into(), "read".into()];
        let marked_unread_again = sample_email();
        assert!(!merged_viewed_state(&existing, &marked_unread_again));

        let mut still_read = sample_email();
        still_read.read = true;
        still_read.labels = vec!["inbox".into(), "read".into()];
        assert!(merged_viewed_state(&existing, &still_read));
    }

    #[test]
    fn stale_provider_snapshot_keeps_newer_local_read_state() {
        let mut existing = sample_email();
        existing.read = true;
        existing.viewed = true;
        existing.labels = vec!["inbox".into(), "read".into()];
        let mut stale_unread = sample_email();

        preserve_existing_read_state(&mut stale_unread, &existing);

        assert!(stale_unread.read);
        assert!(stale_unread.viewed);
        assert!(stale_unread
            .labels
            .iter()
            .any(|label| label.eq_ignore_ascii_case(READ_LABEL)));
        assert!(!stale_unread
            .labels
            .iter()
            .any(|label| label.eq_ignore_ascii_case(UNREAD_LABEL)));
    }

    #[test]
    fn stale_provider_snapshot_does_not_restore_removed_inbox_membership() {
        assert!(stale_snapshot_should_skip(true, Some("archive")));
        assert!(stale_snapshot_should_skip(true, None));
        assert!(!stale_snapshot_should_skip(true, Some("inbox")));
        assert!(!stale_snapshot_should_skip(false, None));
    }

    #[test]
    fn gmail_thread_migration_is_account_scoped_idempotent_and_preserving() {
        let tmp = tempfile::TempDir::new().unwrap();
        for directory in ["inbox", "sent", "archive"] {
            std::fs::create_dir_all(tmp.path().join(directory)).unwrap();
        }

        let mut first = sample_email();
        first.id = "first-local-id".into();
        first.message_id = "shared-wire-id@example.test".into();
        first.thread_id = "shared-wire-id@example.test".into();
        first.inbox = "gmail:first@example.test".into();
        let first_content =
            render_email_md(&first).replacen("subject:", "custom_marker: keep-me\nsubject:", 1);
        vault_lib::write_atomic(&tmp.path().join("inbox/first.md"), &first_content).unwrap();

        let mut reply = first.clone();
        reply.id = "reply-local-id".into();
        reply.message_id = "reply-wire-id@example.test".into();
        vault_lib::write_atomic(&tmp.path().join("sent/reply.md"), &render_email_md(&reply))
            .unwrap();

        let mut second_account = first.clone();
        second_account.id = "second-local-id".into();
        second_account.inbox = "gmail:second@example.test".into();
        vault_lib::write_atomic(
            &tmp.path().join("archive/second.md"),
            &render_email_md(&second_account),
        )
        .unwrap();

        let mut local = first.clone();
        local.id = "local-only-id".into();
        local.inbox = "local:mail".into();
        let local_content = render_email_md(&local);
        vault_lib::write_atomic(&tmp.path().join("archive/local.md"), &local_content).unwrap();

        assert_eq!(migrate_gmail_thread_ids(tmp.path()).unwrap(), 3);
        assert_eq!(migrate_gmail_thread_ids(tmp.path()).unwrap(), 0);

        let migrated_first = vault_lib::read_record(&tmp.path().join("inbox/first.md")).unwrap();
        let migrated_reply = vault_lib::read_record(&tmp.path().join("sent/reply.md")).unwrap();
        let migrated_second =
            vault_lib::read_record(&tmp.path().join("archive/second.md")).unwrap();
        let first_summary = parse_email_md(&migrated_first).unwrap();
        let reply_summary = parse_email_md(&migrated_reply).unwrap();
        let second_summary = parse_email_md(&migrated_second).unwrap();

        assert_eq!(first_summary.thread_id, reply_summary.thread_id);
        assert_ne!(first_summary.thread_id, second_summary.thread_id);
        assert!(migrated_first.contains("custom_marker: keep-me"));
        assert_eq!(
            vault_lib::read_record(&tmp.path().join("archive/local.md")).unwrap(),
            local_content
        );
    }

    #[test]
    fn render_email_md_roundtrips_sender_with_quotes_and_trailing_text() {
        let mut original = sample_email();
        original.from = "'Example Sender' via example_relay".into();

        let md = render_email_md(&original);
        let parsed = parse_email_md(&md).expect("parse sender with YAML punctuation");

        assert_eq!(parsed.from, original.from);
    }

    #[test]
    fn parse_email_md_recovers_legacy_misquoted_sender() {
        let original = sample_email();
        let md = render_email_md(&original);
        let from_line = md
            .lines()
            .find(|line| line.starts_with("from: "))
            .unwrap()
            .to_string();
        let md = md.replacen(&from_line, "from: 'Example Sender' via example_relay", 1);

        let parsed = parse_email_md(&md).expect("recover legacy sender quoting");

        assert_eq!(parsed.from, "'Example Sender' via example_relay");
    }

    #[test]
    fn list_loader_reads_preview_without_loading_body_or_html() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("message.md");
        let email = sample_email();
        std::fs::write(&path, render_email_md(&email)).unwrap();
        std::fs::write(path.with_extension("html"), "<p>remote body</p>").unwrap();

        let summary = load_email_summary_from_path(&path).unwrap();
        assert_eq!(summary.preview, email.preview);
        assert!(summary.body.is_empty());
        assert!(summary.html.is_none());
    }

    #[test]
    fn short_id_is_deterministic_and_compact() {
        let a = short_id("CAHYfhA=Vw_ZGdyFMbDdCJLB2URqExf330MZ4aTUmGS9pnTU8pQ@mail.gmail.com");
        let b = short_id("CAHYfhA=Vw_ZGdyFMbDdCJLB2URqExf330MZ4aTUmGS9pnTU8pQ@mail.gmail.com");
        assert_eq!(a, b, "deterministic across calls");
        assert_eq!(a.len(), SHORT_ID_LEN);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
        // Different inputs hash to different ids.
        assert_ne!(a, short_id("different-id@host"));
    }

    #[test]
    fn email_filename_combines_slug_and_short_id() {
        let name = email_filename(
            "API v2 — release notes",
            "CAHYfhA=Vw_ZGdyFMbDd@mail.gmail.com",
        );
        assert!(name.ends_with(".md"));
        assert!(name.starts_with("api-v2-release-notes-"));
        // Bounded length even for very long subjects.
        let huge_subject = "this is a very long subject line ".repeat(20);
        let bounded = email_filename(&huge_subject, "id@host");
        // 40 chars slug cap + dash + 8 char hash + ".md" = ~53 chars max.
        assert!(bounded.len() <= 60);
    }

    #[test]
    fn email_filename_falls_back_when_subject_is_empty() {
        let name = email_filename("", "id@host");
        // Just `<short-id>.md` when there's nothing to slug.
        assert_eq!(name.len(), SHORT_ID_LEN + 3);
        assert!(name.ends_with(".md"));
    }

    #[test]
    fn render_email_md_roundtrips_gmail_style_id() {
        // Real-world message-ids carry `=`, `@`, `+`, `/` — chars that are
        // technically valid in YAML plain scalars but historically fragile
        // across parsers. Always-quoted output (json_string) sidesteps the
        // whole class of bugs.
        let body = "tracking the click".to_string();
        let preview = derive_preview(&body);
        let original = EmailSummary {
            id: "CAHYfhA=Vw_ZGdyFMbDdCJLB2URqExf330MZ4aTUmGS9pnTU8pQ@Mail.gmail.com".into(),
            message_id: "wire-message@example.test".into(),
            thread_id: "thread-2/abc=def".into(),
            from: "Beehiiv".into(),
            from_email: "noreply@beehiiv.com".into(),
            subject: "API v2 — release notes".into(),
            body,
            html: None,
            preview,
            date: "2026-04-30T10:00:00-04:00".into(),
            read: false,
            viewed: false,
            labels: vec!["inbox".into(), "unread".into()],
            mentions: vec!["beehiiv".into()],
            links: vec![],
            inbox: "inbox_personal".into(),
            path: String::new(),
            attachments: Vec::new(),
        };
        let md = render_email_md(&original);
        let parsed = parse_email_md(&md).expect("parse roundtrip with gmail id");
        assert_eq!(parsed.id, original.id);
        assert_eq!(parsed.thread_id, original.thread_id);
        assert_eq!(parsed.inbox, original.inbox);
        assert_eq!(parsed.from_email, original.from_email);
    }

    #[test]
    fn parse_email_md_tolerates_legacy_account_field() {
        let md = "---\n\
                  type: email\n\
                  id: legacy1\n\
                  thread: t1\n\
                  account: personal\n\
                  from: Old\n\
                  from_email: old@example.com\n\
                  subject: hi\n\
                  date: 2026-04-25T10:00:00-04:00\n\
                  read: false\n\
                  labels: []\n\
                  mentions: []\n\
                  links: []\n\
                  ---\n\nbody\n";
        let parsed = parse_email_md(md).expect("parses");
        assert_eq!(parsed.inbox, "personal");
        assert!(!parsed.viewed);
    }

    #[test]
    fn email_date_cmp_orders_across_timezones() {
        // Repro: sent messages persist with the local TZ offset (`-04:00`),
        // received messages can come back in UTC. Lex string
        // compare orders `16:37-04:00` before `20:07Z`, mangling the
        // chronological order. This pins the parsed-instant fix.
        let template = sample_email();
        let make = |id: &str, date: &str| {
            let mut x = template.clone();
            x.id = id.into();
            x.date = date.into();
            x
        };
        let a = make("a", "2026-04-30T16:05:00-04:00"); // local sent — 20:05 UTC
        let b = make("b", "2026-04-30T20:07:00Z"); // received — 20:07 UTC
        let c = make("c", "2026-04-30T16:37:00-04:00"); // local sent — 20:37 UTC
        let mut v = [a, b, c];
        v.sort_by(email_date_cmp);
        let ids: Vec<&str> = v.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["a", "b", "c"],
            "should be true chronological order"
        );
    }

    #[test]
    fn extract_links_finds_urls() {
        let body = "see https://example.com/foo and http://other.test/bar.\nAlso https://x.com)";
        let links = extract_links(body);
        assert!(links.contains(&"https://example.com/foo".to_string()));
        assert!(links.contains(&"http://other.test/bar".to_string()));
        assert!(links.contains(&"https://x.com".to_string()));
    }

    #[test]
    fn kebab_slug_lowercases_and_dashes() {
        assert_eq!(kebab_slug("Alex Rivera"), "alex-rivera");
        assert_eq!(kebab_slug("  Multiple   Spaces  "), "multiple-spaces");
        assert_eq!(kebab_slug("O'Reilly Inc."), "o-reilly-inc");
    }

    #[test]
    fn labels_to_read_uses_label_convention() {
        // `unread` present → unread, regardless of `read` (we're seeing the
        // message before the labelset was updated).
        assert!(!labels_to_read(&["unread".into(), "inbox".into()]));
        // `read` present + no `unread` → read.
        assert!(labels_to_read(&["read".into(), "inbox".into()]));
        // No `unread` and no `read` → read (the user marked it read in
        // another client which removed `unread` without adding `read`).
        assert!(labels_to_read(&["inbox".into()]));
        // Both present → trust `read`; the message is already not-unread.
        assert!(labels_to_read(&["read".into(), "unread".into()]));
        // Case-insensitive on both sides.
        assert!(!labels_to_read(&["Unread".into()]));
        assert!(labels_to_read(&["READ".into()]));
    }

    #[test]
    fn derive_preview_caps_and_normalizes_whitespace() {
        let body = "First line.\nSecond line.\n\nThird paragraph.".to_string();
        let p = derive_preview(&body);
        assert!(!p.contains('\n'));
    }

    #[test]
    fn derive_email_preview_prefers_clean_html() {
        let body = "---------- View image: (https://media.beehiiv.com/cdn-cgi/image/foo)";
        let html = r#"
            <html>
              <head><style>.hidden { display: none; }</style></head>
              <body>
                <img alt="View image: https://media.beehiiv.com/cdn-cgi/image/foo">
                <p>Longtime subscribers will notice today&rsquo;s newsletter is different.</p>
              </body>
            </html>
        "#;

        let preview = derive_email_preview(body, Some(html), "");

        assert!(preview.starts_with("Longtime subscribers"));
        assert!(preview.contains("today's newsletter"));
        assert!(!preview.contains("View image"));
        assert!(!preview.contains("media.beehiiv.com"));
    }

    #[test]
    fn derive_email_preview_strips_zero_width_email_entities() {
        let html = r#"
            <p>
              PLUS: Strategic theater vs real product work
              &zwnj; &zwnj; &#8204; &#x200d; &ZeroWidthSpace; done
            </p>
        "#;

        let preview = derive_email_preview("", Some(html), "");

        assert_eq!(preview, "PLUS: Strategic theater vs real product work done");
        assert!(!preview.contains("zwnj"));
        assert!(!preview.contains('\u{200C}'));
        assert!(!preview.contains('\u{200D}'));
    }

    #[test]
    fn derive_email_preview_cleans_provider_fallback_preview() {
        let preview = derive_email_preview("", None, "PLUS: work &zwnj; &amp; craft");

        assert_eq!(preview, "PLUS: work & craft");
    }

    #[test]
    fn parse_email_md_cleans_zero_width_entities_from_body_preview() {
        let md = "---\n\
                  type: email\n\
                  id: e1\n\
                  thread: t1\n\
                  inbox: inbox_personal\n\
                  from: Tech Twitter\n\
                  from_email: hello@example.com\n\
                  subject: Interfaces Need Better Workflows\n\
                  date: 2026-05-17T06:02:00-07:00\n\
                  read: false\n\
                  labels: []\n\
                  mentions: []\n\
                  links: []\n\
                  ---\n\nPLUS: work &zwnj; &amp; craft\n";

        let parsed = parse_email_md(md).expect("parses email");

        assert_eq!(parsed.preview, "PLUS: work & craft");
    }

    #[test]
    fn decode_html_entities_leaves_bare_ampersands_alone() {
        assert_eq!(decode_html_entities("AT&T &amp; R&D"), "AT&T & R&D");
    }

    #[test]
    fn short_id_is_stable_for_real_world_ids_with_special_chars() {
        // Real message-ids carry `=`, `@`, `+`, `/`. short_id is used for
        // filename lookups, so it must be deterministic and fixed-length
        // for every one of them.
        for id in [
            "CAHYfhA=Vw_ZGdyFMbDdCJLB2URqExf330MZ4aTUmGS9pnTU8pQ@mail.gmail.com",
            "msg+tag/segment=value@example.com",
            "a/b/c=d+e@host",
            "<simple@local>",
        ] {
            let first = short_id(id);
            let second = short_id(id);
            assert_eq!(first, second, "short_id must be deterministic for {id}");
            assert_eq!(first.len(), SHORT_ID_LEN, "fixed length for {id}");
            assert!(
                first.chars().all(|c| c.is_ascii_alphanumeric()),
                "base36 output for {id}"
            );
        }
    }

    #[test]
    fn sanitize_attachment_filename_strips_path_separators_and_dots() {
        // Path separators, backslashes, and null bytes are removed so the
        // result can never escape attachment_dir.
        assert_eq!(
            sanitize_attachment_filename("../../etc/passwd", "fallback"),
            "etcpasswd"
        );
        assert_eq!(
            sanitize_attachment_filename("..\\..\\windows\\system32", "fallback"),
            "windowssystem32"
        );
        assert_eq!(
            sanitize_attachment_filename("foo\0bar.pdf", "fallback"),
            "foobar.pdf"
        );
        // Leading dots are trimmed so we never produce a hidden file.
        assert_eq!(
            sanitize_attachment_filename(".hidden.txt", "fallback"),
            "hidden.txt"
        );
        // A clean filename passes through untouched.
        assert_eq!(
            sanitize_attachment_filename("report.pdf", "fallback"),
            "report.pdf"
        );
    }

    #[test]
    fn sanitize_attachment_filename_falls_back_on_empty_input() {
        // Empty input, and input that sanitizes to nothing, both fall back
        // to the deterministic `attachment-<id>.bin` name.
        assert_eq!(
            sanitize_attachment_filename("", "msg42"),
            "attachment-msg42.bin"
        );
        assert_eq!(
            sanitize_attachment_filename("///", "msg42"),
            "attachment-msg42.bin"
        );
        assert_eq!(
            sanitize_attachment_filename("...", "msg42"),
            "attachment-msg42.bin"
        );
    }

    #[test]
    fn safe_dir_component_passes_through_safe_ids() {
        // Safe ids — no path separators, no `..`, no control chars — must
        // pass through verbatim so existing on-disk attachment dirs keep
        // resolving.
        assert_eq!(safe_dir_component("gmail-1a2b3c"), "gmail-1a2b3c");
        assert_eq!(safe_dir_component("gmail-uid-42"), "gmail-uid-42");
        // A realistic id with `=`/`@`/`+` has no path separators, so it must
        // pass through unchanged.
        let messy = "msg=01HM3Z+abc@inbox.example.to";
        assert_eq!(safe_dir_component(messy), messy);
    }

    #[test]
    fn safe_dir_component_neutralizes_unsafe_ids() {
        // Each unsafe id must collapse to a value with no path separators,
        // no `..`, and a non-empty body — so it can never escape its parent.
        let unsafe_ids = ["../../etc/passwd", "a/b", "a\\b", "..", "", "a\0b"];
        for id in unsafe_ids {
            let out = safe_dir_component(id);
            assert!(!out.is_empty(), "empty output for {id:?}");
            assert!(!out.contains('/'), "slash in output for {id:?}: {out}");
            assert!(!out.contains('\\'), "backslash in output for {id:?}: {out}");
            assert!(!out.contains(".."), "dotdot in output for {id:?}: {out}");
        }
    }

    #[test]
    fn attachment_dir_contains_traversal_id() {
        // A traversal-shaped message_id is sanitized to a deterministic hash
        // component, so the returned path stays inside attachments/mail/ and
        // contains no `..` segments.
        let vault = Path::new("/vault");
        let dir = attachment_dir(vault, "../../../../tmp/evil");
        let mail_root = vault.join("attachments").join("mail");
        assert!(dir.starts_with(&mail_root), "{dir:?} escaped {mail_root:?}");
        assert!(
            !dir.to_string_lossy().contains(".."),
            "{dir:?} still contains a traversal segment"
        );
    }
}
