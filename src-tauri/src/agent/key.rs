use super::HermesConfigMeta;
use keyring::Entry;
use std::fs;
use std::path::{Path, PathBuf};

const ENV_VARS: [&str; 3] = ["WOODSHED_AGENT_API_KEY", "HERMES_API_KEY", "API_SERVER_KEY"];
const KEYCHAIN_SERVICE: &str = "Woodshed Agent";
const KEYCHAIN_ACCOUNT: &str = "default";

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("Hermes API key not configured. Paste it in Settings > Agent, or set WOODSHED_AGENT_API_KEY in .env.local.")]
    Missing,
}

pub fn resolve(config: &HermesConfigMeta) -> Result<String, KeyError> {
    if let Some(key) = env_key() {
        return Ok(key);
    }
    if let Some(key) = read_env_local()? {
        return Ok(key);
    }
    if let Some(key) = keychain_key() {
        return Ok(key);
    }
    if let Some(key) = config.api_key.as_deref().and_then(super::normalize_api_key) {
        return Ok(key);
    }
    Err(KeyError::Missing)
}

pub fn store(value: &str) -> Result<(), String> {
    let key = super::normalize_api_key(value).ok_or_else(|| "API key is empty".to_string())?;
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("open agent credential: {e}"))?
        .set_password(&key)
        .map_err(|e| format!("store agent credential: {e}"))
}

pub fn forget() -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("open agent credential: {e}"))?;
    match entry.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete agent credential: {e}")),
    }
}

fn keychain_key() -> Option<String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .ok()?
        .get_password()
        .ok()
        .and_then(|value| super::normalize_api_key(&value))
}

pub fn has_env_key() -> bool {
    env_key().is_some() || read_env_local().ok().flatten().is_some()
}

fn env_key() -> Option<String> {
    ENV_VARS.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .and_then(|v| super::normalize_api_key(&v))
    })
}

fn read_env_local() -> Result<Option<String>, KeyError> {
    let Some(file) = find_env_local() else {
        return Ok(None);
    };
    Ok(ENV_VARS
        .iter()
        .find_map(|name| parse_env_var(&file, name).and_then(|v| super::normalize_api_key(&v))))
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
    use std::io::Write;

    #[test]
    fn parses_woodshed_agent_api_key_from_env_file() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        writeln!(tmp, "WOODSHED_AGENT_API_KEY=\"Bearer abc123\"").unwrap();
        assert_eq!(
            parse_env_var(tmp.path(), "WOODSHED_AGENT_API_KEY").as_deref(),
            Some("Bearer abc123")
        );
    }
}
