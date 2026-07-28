// Gmail credential resolution.
//
// An account is two values: an email address and an App Password (the
// 16-char Google-issued secret).
//
// Where the App Password lives:
//   - Release: `<app_data_dir>/secrets.json`, behind `CredentialBroker`.
//     The config store carries only non-secret metadata.
//   - Dev: `GMAIL_EMAIL` + `GMAIL_APP_PASSWORD` from the environment or
//     `.env.local` (see `env_or_local_for`).
//
// Legacy keychain and plaintext-config entries are one-time migration inputs.

use crate::credentials::{CredentialBroker, CredentialId};
use crate::sync_ext::MutexRecover;
use keyring::Entry;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const KEYCHAIN_SERVICE: &str = "Woodshed Gmail";

const ENV_EMAIL: &str = "GMAIL_EMAIL";
const ENV_PASSWORD: &str = "GMAIL_APP_PASSWORD";

#[derive(Debug, Clone)]
pub struct Credentials {
    pub email: String,
    pub app_password: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CredsError {
    #[error("no Gmail credentials for {email}. Set GMAIL_EMAIL/GMAIL_APP_PASSWORD env vars (dev) or paste them in Settings → Accounts → Gmail accounts (release).")]
    NotFound { email: String },
    #[error("keychain error: {0}")]
    Keychain(#[from] keyring::Error),
}

/// Resolve credentials for a specific account from the dev-only env
/// sources. The release home for an App Password is the Tauri config
/// store (see `commands::gmail`), not the keychain — so this only covers
/// the `.env.local` path used in development:
///   1. `GMAIL_EMAIL` + `GMAIL_APP_PASSWORD` env vars (if email matches).
///   2. `.env.local` walked up from cwd (if email matches).
///
/// Store-backed resolution + cache priming lives in
/// `commands::gmail::resolve_credentials`.
pub fn env_or_local_for(email: &str) -> Option<Credentials> {
    let email = email.trim();
    if email.is_empty() {
        return None;
    }
    if let Some(creds) = env_creds() {
        if creds.email.eq_ignore_ascii_case(email) {
            return Some(creds);
        }
    }
    if let Some(creds) = env_local_creds().ok().flatten() {
        if creds.email.eq_ignore_ascii_case(email) {
            return Some(creds);
        }
    }
    None
}

/// Read a legacy App Password out of the OS keychain, if one exists. Used once
/// per account to migrate pre-existing secrets into the credential broker;
/// after migration the keychain is never read again. Reading a
/// keychain item from an unsigned/ad-hoc-signed binary triggers the
/// macOS access prompt — which is exactly what moving the secret into the
/// local credential store eliminates going forward.
pub fn legacy_keychain_password(email: &str) -> Option<String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, email).ok()?;
    match entry.get_password() {
        Ok(pw) if !pw.trim().is_empty() => Some(pw),
        _ => None,
    }
}

/// Email of the env-vars account, if one is configured. Used to merge
/// env-only accounts into the Tauri-store-driven account list — the
/// list's source of truth is the store, but a user with creds only in
/// `.env.local` should still see "their account" in the UI.
pub fn env_account_email() -> Option<String> {
    env_creds()
        .map(|c| c.email)
        .or_else(|| env_local_creds().ok().flatten().map(|c| c.email))
}

fn env_creds() -> Option<Credentials> {
    let email = std::env::var(ENV_EMAIL).ok()?.trim().to_string();
    let pw = std::env::var(ENV_PASSWORD).ok()?.trim().to_string();
    if email.is_empty() || pw.is_empty() {
        return None;
    }
    Some(Credentials {
        email,
        app_password: pw,
    })
}

fn env_local_creds() -> Result<Option<Credentials>, CredsError> {
    resolve_env_local()
}

/// In-memory per-account credential cache. Primed when the user adds an
/// account and on the first store/env resolve of a session; subsequent
/// lookups return the cached value with no disk or keychain access.
///
/// Invalidated entries on account remove + on auth-failure paths so
/// stale passwords don't outlive their usefulness.
pub struct CredsCache {
    cached: Mutex<HashMap<String, Credentials>>,
}

impl CredsCache {
    pub fn new() -> Self {
        Self {
            cached: Mutex::new(HashMap::new()),
        }
    }

    /// Return cached creds for an account without resolving from any
    /// backing store. Resolution + priming lives in
    /// `commands::gmail::resolve_credentials`.
    pub fn peek(&self, email: &str) -> Option<Credentials> {
        let key = email.trim().to_ascii_lowercase();
        self.cached.lock_recover().get(&key).cloned()
    }

    /// Prime the cache with creds the user just typed (or that we just
    /// resolved). Avoids re-prompting on the very next operation.
    pub fn set(&self, creds: Credentials) {
        let key = creds.email.trim().to_ascii_lowercase();
        self.cached.lock_recover().insert(key, creds);
    }

    pub fn invalidate(&self, email: &str) {
        let key = email.trim().to_ascii_lowercase();
        self.cached.lock_recover().remove(&key);
    }
}

impl Default for CredsCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve a prompt-free persisted credential and prime the session cache.
pub fn persisted_for(
    cache: &CredsCache,
    broker: &CredentialBroker,
    email: &str,
) -> Result<Option<Credentials>, String> {
    let Some(app_password) = broker.resolve(&CredentialId::gmail(email))? else {
        return Ok(None);
    };
    let credentials = Credentials {
        email: email.trim().to_string(),
        app_password,
    };
    cache.set(credentials.clone());
    Ok(Some(credentials))
}

/// Forget an account's legacy keychain App Password. Idempotent.
pub fn forget_legacy_keychain(email: &str) -> Result<(), CredsError> {
    let pw_entry = Entry::new(KEYCHAIN_SERVICE, email)?;
    match pw_entry.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn resolve_env_local() -> Result<Option<Credentials>, CredsError> {
    let Some(file) = find_env_local() else {
        return Ok(None);
    };
    let email = parse_env_var(&file, ENV_EMAIL);
    let pw = parse_env_var(&file, ENV_PASSWORD);
    match (email, pw) {
        (Some(email), Some(app_password)) if !email.is_empty() && !app_password.is_empty() => {
            Ok(Some(Credentials {
                email,
                app_password,
            }))
        }
        _ => Ok(None),
    }
}

fn find_env_local() -> Option<PathBuf> {
    let mut dir: Option<PathBuf> = std::env::current_dir().ok();
    for _ in 0..5 {
        let d = dir.clone()?;
        let candidate = d.join(".env.local");
        if candidate.exists() {
            return Some(candidate);
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    None
}

fn parse_env_var(path: &Path, key: &str) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((k, v)) = trimmed.split_once('=') else {
            continue;
        };
        if k.trim() == key {
            let v = v.trim();
            // Strip optional surrounding single/double quotes.
            let v = v
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                .unwrap_or(v);
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialBroker, CredentialId};
    use std::io::Write;

    #[test]
    fn parses_email_and_password_from_env_local() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        writeln!(tmp, "OTHER=ignored").unwrap();
        writeln!(tmp, "GMAIL_EMAIL=foo@gmail.com").unwrap();
        writeln!(tmp, "GMAIL_APP_PASSWORD=\"abcd efgh ijkl mnop\"").unwrap();
        assert_eq!(
            parse_env_var(tmp.path(), ENV_EMAIL),
            Some("foo@gmail.com".into())
        );
        assert_eq!(
            parse_env_var(tmp.path(), ENV_PASSWORD),
            Some("abcd efgh ijkl mnop".into())
        );
    }

    #[test]
    fn skips_comments_and_blanks() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        writeln!(tmp, "# GMAIL_EMAIL=should_skip").unwrap();
        writeln!(tmp).unwrap();
        writeln!(tmp, "GMAIL_EMAIL=real@gmail.com").unwrap();
        assert_eq!(
            parse_env_var(tmp.path(), ENV_EMAIL),
            Some("real@gmail.com".into())
        );
    }

    #[test]
    fn stored_credential_primes_the_session_cache() {
        let temp = tempfile::TempDir::new().unwrap();
        let broker = CredentialBroker::new(temp.path());
        let cache = CredsCache::new();
        let email = "owner@example.com";
        broker
            .save(&CredentialId::gmail(email), "stored-secret")
            .unwrap();

        let resolved = persisted_for(&cache, &broker, email).unwrap().unwrap();
        broker.forget(&CredentialId::gmail(email)).unwrap();

        assert_eq!(resolved.app_password, "stored-secret");
        assert_eq!(cache.peek(email).unwrap().app_password, "stored-secret");
    }
}
