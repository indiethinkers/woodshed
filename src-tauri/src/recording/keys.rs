// Transcription provider key custody.
//
// One key: Deepgram (speech-to-text + text-to-speech), used by voice dictation
// and voice mode. Resolves dev → release in this order:
//   1. process env (`DEEPGRAM_API_KEY`)
//   2. `.env.local` at the repo root (dev convenience)
//   3. OS keychain (release) — service "Woodshed Transcription", account
//      "deepgram". Pasted once in Settings → Accounts.

use keyring::Entry;
use std::fs;
use std::path::PathBuf;

const KEYCHAIN_SERVICE: &str = "Woodshed Transcription";

pub fn deepgram_key() -> Result<String, String> {
    resolve("DEEPGRAM_API_KEY", "deepgram")
}

/// True when a key is configured by any path. Cheap probe for the UI /
/// settings status badge (doesn't surface the secret).
pub fn deepgram_configured() -> bool {
    deepgram_key().is_ok()
}

/// Persist a key to the OS keychain (release flow — Settings paste). An empty
/// string clears it.
pub fn set_key(account: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| e.to_string())?;
    if value.trim().is_empty() {
        let _ = entry.delete_password();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

fn resolve(env_var: &str, keychain_account: &str) -> Result<String, String> {
    if let Ok(v) = std::env::var(env_var) {
        if !v.trim().is_empty() {
            return Ok(v);
        }
    }
    if let Some(v) = read_env_local(env_var) {
        return Ok(v);
    }
    if let Ok(entry) = Entry::new(KEYCHAIN_SERVICE, keychain_account) {
        if let Ok(secret) = entry.get_password() {
            if !secret.trim().is_empty() {
                return Ok(secret);
            }
        }
    }
    Err(format!(
        "{env_var} not configured. Set it in .env.local (dev) or paste your key in Settings → Accounts (release)."
    ))
}

/// Walk up from the cwd looking for `.env.local` and parse `KEY=value`.
fn read_env_local(var: &str) -> Option<String> {
    let mut dir = std::env::current_dir().ok()?;
    for _ in 0..6 {
        let candidate = dir.join(".env.local");
        if candidate.is_file() {
            if let Some(v) = parse_env_var(&candidate, var) {
                return Some(v);
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn parse_env_var(file: &PathBuf, var: &str) -> Option<String> {
    let content = fs::read_to_string(file).ok()?;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == var {
                let v = v.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}
