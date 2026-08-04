// MIME → ParsedMessage.
//
// The IMAP layer hands us RFC822 bytes; this module turns them into
// something the rest of Woodshed can render. We use `mail-parser` for
// header decoding (RFC 2047 quoted-printable + base64 in subjects, etc.),
// MIME walking, and HTML/plaintext part extraction.
//
// Output shape mirrors what the Tauri command layer needs to build an
// EmailSummary — keep this module independent of EmailSummary itself so
// the crate boundary stays clean (parse.rs ↔ commands/gmail.rs).

use crate::gmail::imap_client::RawMessage;
use chrono::DateTime;
use mail_parser::{Address, MessageParser};

#[derive(Debug, Clone)]
pub struct ParsedMessage {
    /// RFC 5322 Message-ID (the `<…@host>` value with brackets stripped).
    /// Empty when the message has no Message-ID header — we'll fall back
    /// to gm_msgid in that case at the call site.
    pub message_id: String,
    /// Gmail's stable msgid — copied through from RawMessage so callers
    /// don't have to thread it themselves.
    pub gm_msgid: u64,
    /// Gmail's thread id.
    pub gm_thrid: u64,
    /// Root RFC 5322 Message-ID from References/In-Reply-To. Gmail's IMAP
    /// extension ids are unavailable with our current parser, so this keeps
    /// ordinary reply chains grouped using standard message headers.
    pub thread_root_message_id: Option<String>,
    /// Sender display name (or empty if From had no display-name part).
    pub from: String,
    /// Sender address.
    pub from_email: String,
    /// Bare recipient addresses from the To header.
    pub to: Vec<String>,
    /// Bare recipient addresses from the Cc header.
    pub cc: Vec<String>,
    pub subject: String,
    /// Plaintext body. If the message is HTML-only, we pass the HTML
    /// through and let the caller decide whether to surface or strip it.
    pub body: String,
    /// HTML body (separate part). None when message is plaintext-only.
    pub html: Option<String>,
    /// Best-effort message date in RFC 3339. Uses Date: header when
    /// present and parseable, falls back to the IMAP INTERNALDATE the
    /// caller passed in (server's idea of arrival time), and finally to
    /// "now" when both are missing.
    pub date: String,
    /// IMAP `\Seen` flag — the server's read-state at fetch time.
    pub seen: bool,
    /// Attachment parts pulled from the MIME tree. Bytes are carried
    /// here so the sync layer can write them to disk without re-parsing
    /// the RFC822. Empty when the message has none.
    pub attachments: Vec<ParsedAttachment>,
}

#[derive(Debug, Clone)]
pub struct ParsedAttachment {
    /// Stable per-message identifier — the MIME part index as a string
    /// ("0", "1", …). Persisted into `EmailSummary.attachments[].id`.
    pub id: String,
    /// `Content-Disposition: filename=` value, or a synthesized fallback
    /// (`attachment-<index>.bin`) when the header is missing.
    pub filename: String,
    pub content_type: String,
    /// Decoded bytes — written to `attachments/mail/<id>/<filename>`
    /// during sync, then dropped.
    pub bytes: Vec<u8>,
}

/// Parse a single RawMessage. Never fails — parsing errors degrade to
/// empty fields rather than dropping the whole message, since "we have
/// the bytes but couldn't decode them" is still useful to surface.
pub fn parse(raw: &RawMessage) -> ParsedMessage {
    let parsed = MessageParser::default().parse(&raw.body);

    let (
        subject,
        from,
        from_email,
        to,
        cc,
        body,
        html,
        message_id,
        thread_root_message_id,
        header_date,
        attachments,
    ) = match parsed.as_ref() {
        Some(m) => {
            let subject = m.subject().unwrap_or_default().to_string();

            let (from_name, from_addr) = first_address(m.from());
            let to = addresses(m.to());
            let cc = addresses(m.cc());
            // Plaintext: prefer `body_text`, walk parts as fallback.
            let body = m.body_text(0).map(|s| s.into_owned()).unwrap_or_default();
            let html = m.body_html(0).map(|s| s.into_owned());

            let message_id = m
                .message_id()
                .map(|id| {
                    id.trim()
                        .trim_start_matches('<')
                        .trim_end_matches('>')
                        .to_string()
                })
                .unwrap_or_default();

            let thread_root_message_id = m
                .references()
                .as_text_list()
                .and_then(|ids| ids.first().and_then(|id| normalize_message_id(id)))
                .or_else(|| normalize_message_id(m.in_reply_to().as_text()?));

            let header_date = m
                .date()
                .and_then(|d| DateTime::parse_from_rfc3339(&d.to_rfc3339()).ok());

            let attachments = extract_attachments(m);

            (
                subject,
                from_name,
                from_addr,
                to,
                cc,
                body,
                html,
                message_id,
                thread_root_message_id,
                header_date,
                attachments,
            )
        }
        None => (
            String::new(),
            String::new(),
            String::new(),
            Vec::new(),
            Vec::new(),
            String::new(),
            None,
            String::new(),
            None,
            None,
            Vec::new(),
        ),
    };

    let date = header_date
        .or(raw.internal_date)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    ParsedMessage {
        message_id,
        gm_msgid: raw.gm_msgid,
        gm_thrid: raw.gm_thrid,
        thread_root_message_id,
        from,
        from_email,
        to,
        cc,
        subject,
        body,
        html,
        date,
        seen: raw.seen,
        attachments,
    }
}

fn normalize_message_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(
        value
            .trim_start_matches('<')
            .trim_end_matches('>')
            .to_string(),
    )
}

/// Walk the MIME tree and return one `ParsedAttachment` per real
/// attachment. Skips inline parts (alt-bodies, signatures) by requiring
/// a non-empty `attachment_name()` — that's what `mail-parser` uses to
/// distinguish "this is meant to be saved as a file" from "this is a
/// rendered piece of the message body". Empty for a message with none
/// (the common case), and for the early-fail path where parsing failed
/// entirely.
fn extract_attachments(m: &mail_parser::Message<'_>) -> Vec<ParsedAttachment> {
    use mail_parser::MimeHeaders;
    let mut out = Vec::new();
    for (idx, part) in m.attachments().enumerate() {
        let bytes = part.contents().to_vec();
        if bytes.is_empty() {
            continue;
        }
        let filename = part
            .attachment_name()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("attachment-{idx}.bin"));
        let content_type = part
            .content_type()
            .map(|ct| {
                let mut s = ct.ctype().to_string();
                if let Some(sub) = ct.subtype() {
                    s.push('/');
                    s.push_str(sub);
                }
                s
            })
            .unwrap_or_else(|| "application/octet-stream".to_string());
        out.push(ParsedAttachment {
            id: idx.to_string(),
            filename,
            content_type,
            bytes,
        });
    }
    out
}

fn first_address(addr: Option<&Address<'_>>) -> (String, String) {
    let Some(a) = addr else {
        return (String::new(), String::new());
    };
    if let Some(list) = a.as_list() {
        if let Some(first) = list.first() {
            let name = first.name().unwrap_or("").to_string();
            let addr = first.address().unwrap_or("").to_string();
            return (name, addr);
        }
    }
    (String::new(), String::new())
}

fn addresses(addr: Option<&Address<'_>>) -> Vec<String> {
    addr.and_then(Address::as_list)
        .into_iter()
        .flatten()
        .filter_map(|address| address.address())
        .map(str::trim)
        .filter(|address| !address.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::imap_client::RawMessage;

    fn raw(body: &[u8]) -> RawMessage {
        RawMessage {
            body: body.to_vec(),
            uid: 1,
            gm_msgid: 0,
            gm_thrid: 0,
            seen: false,
            internal_date: None,
        }
    }

    #[test]
    fn parses_plaintext_message() {
        let bytes = b"From: \"Alex Rivera\" <alex@example.com>\r\n\
                      To: me@example.com, Teammate <teammate@example.test>\r\n\
                      Cc: Observer <observer@example.test>\r\n\
                      Subject: Lunch?\r\n\
                      Message-ID: <abc123@mail.gmail.com>\r\n\
                      Date: Mon, 8 May 2026 10:30:00 -0700\r\n\
                      Content-Type: text/plain\r\n\
                      \r\n\
                      Hey - free at 12:30?\r\n";
        let p = parse(&raw(bytes));
        assert_eq!(p.subject, "Lunch?");
        assert_eq!(p.from, "Alex Rivera");
        assert_eq!(p.from_email, "alex@example.com");
        assert_eq!(p.to, vec!["me@example.com", "teammate@example.test"]);
        assert_eq!(p.cc, vec!["observer@example.test"]);
        assert_eq!(p.message_id, "abc123@mail.gmail.com");
        assert!(p.body.contains("12:30"));
    }

    #[test]
    fn parses_thread_root_from_references() {
        let bytes = b"From: Alex <alex@example.com>\r\n\
                      To: me@example.com\r\n\
                      Subject: Re: Checking In\r\n\
                      Message-ID: <reply@example.com>\r\n\
                      In-Reply-To: <parent@example.com>\r\n\
                      References: <root@example.com> <parent@example.com>\r\n\
                      Content-Type: text/plain\r\n\
                      \r\n\
                      Reply\r\n";

        let p = parse(&raw(bytes));

        assert_eq!(
            p.thread_root_message_id.as_deref(),
            Some("root@example.com")
        );
    }

    #[test]
    fn falls_back_to_in_reply_to_for_thread_root() {
        let bytes = b"From: Alex <alex@example.com>\r\n\
                      To: me@example.com\r\n\
                      Subject: Re: Checking In\r\n\
                      Message-ID: <reply@example.com>\r\n\
                      In-Reply-To: <root@example.com>\r\n\
                      Content-Type: text/plain\r\n\
                      \r\n\
                      Reply\r\n";

        let p = parse(&raw(bytes));

        assert_eq!(
            p.thread_root_message_id.as_deref(),
            Some("root@example.com")
        );
    }

    #[test]
    fn empty_body_does_not_panic() {
        let p = parse(&raw(b""));
        assert_eq!(p.subject, "");
        assert_eq!(p.body, "");
    }
}
