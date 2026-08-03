// Gmail integration via IMAP+SMTP and App Passwords. Direct from the
// desktop app — no Woodshed-operated server. This is the sole courier for
// the Mail surface.
//
// Layering:
//   creds.rs       — App Password + email address resolution helpers for the
//                    prompt-free credential broker, process cache, legacy
//                    Keychain migration, and development environment fallbacks.
//   imap_client.rs — Connect, login, SELECT INBOX, fetch the most recent
//                    N messages as RFC822 bytes. Sync `imap` 2.4 wrapped
//                    in tokio::task::spawn_blocking at the command layer.
//   parse.rs       — RFC822 → EmailSummary via `mail-parser`. Headers,
//                    plaintext body, simple sender extraction.
//
// Woodshed supports multiple accounts, bounded recent Inbox/Sent polling,
// and SMTP send/reply. It does not run an IMAP IDLE state machine; configured
// automatic refresh uses the same foreground polling command as manual sync.

pub(crate) const IMAP_HOST: &str = "imap.gmail.com";
pub(crate) const IMAP_PORT: u16 = 993;

pub mod creds;
pub mod imap_client;
pub mod parse;
pub mod pool;
pub mod smtp_client;

pub use creds::{CredsCache, CredsError};
pub use pool::GmailImapPool;
