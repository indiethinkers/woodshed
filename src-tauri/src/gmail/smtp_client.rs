// SMTP submission via Gmail. Authenticates with the same App Password
// the IMAP path uses; submits over STARTTLS on port 587. lettre 0.11
// with the `tokio1-rustls-tls` feature handles the wire protocol; we
// just hand it a built `Message`.
//
// Message-ID strategy: we generate one locally as `<{ulid}@woodshed.local>`
// before sending so the persisted-to-disk record carries a stable id we
// can dedupe against later (when we eventually read the IMAP Sent folder
// and want to recognize messages we sent ourselves).

use crate::gmail::creds::Credentials;
use lettre::message::header::{ContentType, InReplyTo, MessageId, References};
use lettre::message::{Mailbox, Mailboxes};
use lettre::transport::smtp::authentication::Credentials as SmtpCreds;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use ulid::Ulid;

const HOST: &str = "smtp.gmail.com";

#[derive(Debug, thiserror::Error)]
pub enum SmtpError {
    #[error("SMTP transport: {0}")]
    Transport(#[from] lettre::transport::smtp::Error),
    #[error("Message build: {0}")]
    Build(String),
    #[error("address parse: {0}")]
    Address(#[from] lettre::address::AddressError),
}

/// Inputs for one outbound message. `from_email` is the authenticated
/// account; `from_display` is the optional human-readable name. For
/// replies, set `in_reply_to` and `references` to the original
/// Message-ID(s) to keep Gmail's thread grouping intact.
#[derive(Debug, Clone)]
pub struct OutboundMessage {
    pub from_email: String,
    pub from_display: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    /// Original message-id this is a reply to (if any). Goes into the
    /// `In-Reply-To:` and gets prepended to `References:`.
    pub in_reply_to: Option<String>,
    /// Existing References chain. We append our `in_reply_to` to it.
    pub references: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SendOutcome {
    /// The Message-ID we generated and stamped onto the outgoing message.
    /// Use this as the canonical id when persisting to disk.
    pub message_id: String,
    /// RFC 3339 timestamp at which the SMTP transaction completed.
    pub sent_at: String,
}

/// Send one message via smtp.gmail.com. Async — runs on the Tokio
/// runtime, no spawn_blocking needed (lettre's tokio executor handles
/// everything natively).
pub async fn send(creds: &Credentials, msg: &OutboundMessage) -> Result<SendOutcome, SmtpError> {
    // Generate a stable local Message-ID before SMTP. Format: ULID +
    // a domain we control. Real domain not required by RFC 5322 — but
    // a parseable shape (`local@host`, no angle brackets when given to
    // lettre's typed `MessageId`) is. The on-the-wire output gets
    // bracketed automatically.
    let msgid_local = format!("{}@woodshed.app", Ulid::new());
    // The "canonical" form we return + persist — without angle brackets,
    // matches how Message-IDs sit in EmailSummary frontmatter elsewhere.
    let msgid_canonical = msgid_local.clone();

    let from_mbox: Mailbox = match &msg.from_display {
        Some(name) if !name.trim().is_empty() => format!("{name} <{}>", msg.from_email).parse()?,
        _ => msg.from_email.parse()?,
    };

    let mut builder = Message::builder()
        .from(from_mbox)
        .subject(&msg.subject)
        .header(ContentType::TEXT_PLAIN)
        .header(MessageId::from(msgid_local.clone()));

    // Recipients — at least one of To/Cc/Bcc must be non-empty.
    if msg.to.is_empty() && msg.cc.is_empty() && msg.bcc.is_empty() {
        return Err(SmtpError::Build(
            "at least one recipient required (to/cc/bcc all empty)".into(),
        ));
    }

    if !msg.to.is_empty() {
        let mut to_box = Mailboxes::new();
        for addr in &msg.to {
            to_box.push(addr.parse()?);
        }
        builder = builder.mailbox(lettre::message::header::To::from(to_box));
    }
    if !msg.cc.is_empty() {
        let mut cc_box = Mailboxes::new();
        for addr in &msg.cc {
            cc_box.push(addr.parse()?);
        }
        builder = builder.mailbox(lettre::message::header::Cc::from(cc_box));
    }
    if !msg.bcc.is_empty() {
        let mut bcc_box = Mailboxes::new();
        for addr in &msg.bcc {
            bcc_box.push(addr.parse()?);
        }
        builder = builder.mailbox(lettre::message::header::Bcc::from(bcc_box));
    }

    // Threading headers — only when this is a reply. lettre's typed
    // `InReplyTo` / `References` headers take a single String value
    // (containing space-separated bracketed message-ids per RFC 5322).
    if let Some(reply_target) = &msg.in_reply_to {
        let bracketed = bracket(reply_target);
        builder = builder.header(InReplyTo::from(bracketed.clone()));

        let mut chain: Vec<String> = msg.references.iter().map(|r| bracket(r)).collect();
        if !chain.iter().any(|r| r == &bracketed) {
            chain.push(bracketed);
        }
        builder = builder.header(References::from(chain.join(" ")));
    }

    let email = builder
        .body(msg.body.clone())
        .map_err(|e| SmtpError::Build(e.to_string()))?;

    let smtp_creds = SmtpCreds::new(creds.email.clone(), creds.app_password.clone());
    let mailer: AsyncSmtpTransport<Tokio1Executor> =
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(HOST)?
            .credentials(smtp_creds)
            .build();

    mailer.send(email).await?;

    Ok(SendOutcome {
        message_id: msgid_canonical,
        sent_at: chrono::Local::now().to_rfc3339(),
    })
}

fn bracket(id: &str) -> String {
    let bare = id.trim().trim_start_matches('<').trim_end_matches('>');
    format!("<{bare}>")
}
