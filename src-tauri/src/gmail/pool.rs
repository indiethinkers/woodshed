// IMAP session pool. One persistent connection per Gmail account, kept
// alive across the read/archive/mark-seen operations so we pay the
// TLS+LOGIN cost once instead of every call.
//
// Architecture:
//   GmailImapPool
//     sessions: Mutex<HashMap<email, Arc<Mutex<Session>>>>
//
// Outer mutex guards the map (cheap, contended only at insert time).
// Inner per-session mutex ensures only one IMAP operation runs at a
// time on a given socket — IMAP isn't multiplexed.
//
// Lifecycle:
//   - Lazy-open: first `with_session` call for an email connects+logs in.
//   - Reconnect-on-IO-failure: if the closure errors with a torn-down
//     socket (Gmail closes idle TCP after ~30min), we reconnect once
//     and retry. Auth failures surface as-is so the UI can prompt for
//     a new App Password.
//   - Disconnect: `forget(email)` closes any session for that account.
//     Called from `gmail_account_clear` so dropping an account also
//     drops its socket.
//
// Sync API (`imap` 2.4 has no async). Callers run inside
// `tokio::task::spawn_blocking`.

use crate::gmail::creds::Credentials;
use crate::gmail::imap_client::ImapError;
use crate::gmail::{IMAP_HOST, IMAP_PORT};
use crate::sync_ext::MutexRecover;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub type ImapSessionInner = imap::Session<native_tls::TlsStream<std::net::TcpStream>>;

pub struct GmailImapPool {
    sessions: Mutex<HashMap<String, Arc<Mutex<ImapSessionInner>>>>,
    sent_mailboxes: Mutex<HashMap<String, Option<String>>>,
    all_mailboxes: Mutex<HashMap<String, Option<String>>>,
}

impl GmailImapPool {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            sent_mailboxes: Mutex::new(HashMap::new()),
            all_mailboxes: Mutex::new(HashMap::new()),
        }
    }

    /// Run `f` against a live IMAP session for the account in `creds`.
    /// Lazy-opens the session on first call; reuses it thereafter.
    /// On a connection-level failure during `f`, reconnects and retries
    /// the closure once before bubbling up.
    ///
    /// Concurrent calls for the same account serialize on the per-session
    /// mutex (IMAP isn't multiplexed). Calls for different accounts run
    /// in parallel.
    pub fn with_session<T, F>(&self, creds: &Credentials, mut f: F) -> Result<T, ImapError>
    where
        F: FnMut(&mut ImapSessionInner) -> Result<T, ImapError>,
    {
        let session_arc = self.acquire(creds)?;
        // Hold the per-session lock across the operation. Std Mutex
        // poison would only happen if a prior operation panicked; we
        // recover by reconnecting in that case rather than propagating
        // poison up.
        let mut guard = match session_arc.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                // Drop the poisoned session, replace with a fresh one.
                drop(poisoned);
                self.invalidate(&creds.email);
                let fresh_arc = self.acquire(creds)?;
                return self.with_session_locked(fresh_arc, creds, f);
            }
        };
        match f(&mut guard) {
            Ok(v) => Ok(v),
            Err(e) if is_reconnectable(&e) => {
                // Socket likely torn down. Replace the session in-place
                // and retry once. Holding the guard prevents another
                // caller from racing in with the same dead session.
                let fresh = connect_and_login(creds)?;
                *guard = fresh;
                f(&mut guard)
            }
            Err(e) => Err(e),
        }
    }

    /// Force-close any session for `email`. Called from
    /// `gmail_account_clear` so disconnecting an account doesn't leak
    /// a live IMAP socket.
    pub fn forget(&self, email: &str) {
        self.sent_mailboxes.lock_recover().remove(email);
        self.all_mailboxes.lock_recover().remove(email);
        let removed = {
            let mut map = self.sessions.lock_recover();
            map.remove(email)
        };
        if let Some(arc) = removed {
            // Best-effort logout. If the lock is poisoned or the socket
            // is already gone, just drop — TCP close is a clean exit
            // from Gmail's perspective.
            if let Ok(mut session) = arc.lock() {
                let _ = session.logout();
            }
        }
    }

    pub(crate) fn cached_sent_mailbox(&self, email: &str) -> Option<Option<String>> {
        self.sent_mailboxes.lock_recover().get(email).cloned()
    }

    pub(crate) fn remember_sent_mailbox(&self, email: &str, mailbox: Option<String>) {
        self.sent_mailboxes
            .lock_recover()
            .insert(email.to_string(), mailbox);
    }

    pub(crate) fn cached_all_mailbox(&self, email: &str) -> Option<Option<String>> {
        self.all_mailboxes.lock_recover().get(email).cloned()
    }

    pub(crate) fn remember_all_mailbox(&self, email: &str, mailbox: Option<String>) {
        self.all_mailboxes
            .lock_recover()
            .insert(email.to_string(), mailbox);
    }

    fn acquire(&self, creds: &Credentials) -> Result<Arc<Mutex<ImapSessionInner>>, ImapError> {
        // Fast path: existing session.
        {
            let map = self.sessions.lock_recover();
            if let Some(arc) = map.get(&creds.email) {
                return Ok(arc.clone());
            }
        }
        // Slow path: connect outside the map lock so the network round
        // trip doesn't block other accounts. Race-tolerant: if a
        // sibling caller beat us to insertion we discard our own
        // session and use theirs.
        let session = connect_and_login(creds)?;
        let arc = Arc::new(Mutex::new(session));
        let mut map = self.sessions.lock_recover();
        let entry = map.entry(creds.email.clone()).or_insert(arc).clone();
        Ok(entry)
    }

    fn invalidate(&self, email: &str) {
        let mut map = self.sessions.lock_recover();
        map.remove(email);
    }

    /// Helper used by the poison-recovery path: same as `with_session`
    /// but skips the acquire step and works on a pre-acquired arc.
    fn with_session_locked<T, F>(
        &self,
        session_arc: Arc<Mutex<ImapSessionInner>>,
        creds: &Credentials,
        mut f: F,
    ) -> Result<T, ImapError>
    where
        F: FnMut(&mut ImapSessionInner) -> Result<T, ImapError>,
    {
        let mut guard = session_arc
            .lock()
            .map_err(|_| ImapError::Imap(imap::Error::ConnectionLost))?;
        match f(&mut guard) {
            Ok(v) => Ok(v),
            Err(e) if is_reconnectable(&e) => {
                let fresh = connect_and_login(creds)?;
                *guard = fresh;
                f(&mut guard)
            }
            Err(e) => Err(e),
        }
    }
}

impl Default for GmailImapPool {
    fn default() -> Self {
        Self::new()
    }
}

fn connect_and_login(creds: &Credentials) -> Result<ImapSessionInner, ImapError> {
    let tls = native_tls::TlsConnector::builder().build()?;
    let client = imap::connect((IMAP_HOST, IMAP_PORT), IMAP_HOST, &tls)?;
    let mut session =
        client
            .login(&creds.email, &creds.app_password)
            .map_err(|(err, _)| match &err {
                imap::Error::No(msg) | imap::Error::Bad(msg) => ImapError::AuthFailed {
                    email: creds.email.clone(),
                    message: msg.clone(),
                },
                _ => ImapError::Imap(err),
            })?;
    // Pre-select INBOX so the first operation doesn't spend a round trip
    // on it. All current operations live in INBOX; if a future flow
    // needs another mailbox it'll re-SELECT explicitly.
    session.select("INBOX")?;
    Ok(session)
}

/// Errors that suggest the session is no longer usable. We retry these
/// once with a fresh connection.
fn is_reconnectable(e: &ImapError) -> bool {
    matches!(
        e,
        ImapError::Imap(imap::Error::Io(_))
            | ImapError::Imap(imap::Error::ConnectionLost)
            | ImapError::Imap(imap::Error::TlsHandshake(_))
    )
}
