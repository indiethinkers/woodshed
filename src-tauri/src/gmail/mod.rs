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
// V1 scope (single-account, on-demand pull):
//   - One Gmail account configured at a time. Multi-account is a config
//     change later, not a refactor — `inbox` field on EmailSummary
//     already plays the per-account role on disk.
//   - No IMAP IDLE yet. `gmail_sync_recent` re-fetches the last N on
//     each call; the IDLE state machine + UIDVALIDITY/CONDSTORE handling
//     comes once the basic round-trip works.
//   - No SMTP yet — Phase 1 starts read-only. Adding `gmail_send` is the
//     next slice once we can list mail.

pub mod creds;
pub mod imap_client;
pub mod parse;
pub mod pool;
pub mod smtp_client;

pub use creds::{CredsCache, CredsError};
pub use pool::GmailImapPool;
