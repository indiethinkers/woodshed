use super::{
    is_default_profile_connection, uses_default_profile, CredentialSource, HermesConfigMeta,
};
use crate::credentials::{CredentialBroker, CredentialId};
use keyring::Entry;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use tauri::Manager;

const ENV_VARS: [&str; 3] = ["WOODSHED_AGENT_API_KEY", "HERMES_API_KEY", "API_SERVER_KEY"];
const KEYCHAIN_SERVICE: &str = "Woodshed Agent";
const KEYCHAIN_ACCOUNT: &str = "default";
const MAX_ENV_FILE_BYTES: u64 = 1024 * 1024;
const MAX_ACTIVE_PROFILE_BYTES: u64 = 128;
const MAX_HERMES_PROFILES: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("Hermes API key not configured. Start a configured local Hermes profile, or add a bearer key for a remote endpoint in Settings > Agent.")]
    Missing,
    #[error("{0}")]
    Storage(String),
}

pub fn resolve(app: &tauri::AppHandle, config: &HermesConfigMeta) -> Result<String, KeyError> {
    if let Some(key) = env_key() {
        return Ok(key);
    }
    if let Some(key) = read_env_local()? {
        return Ok(key);
    }
    if let Some(home) = hermes_home(app) {
        if let Some(key) = discover_hermes_key(&home, &config.base_url, &config.model) {
            return Ok(key);
        }
    }
    if uses_default_profile(config) {
        return Err(KeyError::Missing);
    }
    let broker = CredentialBroker::for_app(app).map_err(KeyError::Storage)?;
    if let Some(key) = broker
        .resolve(&CredentialId::agent())
        .map_err(KeyError::Storage)?
        .and_then(|value| super::normalize_api_key(&value))
    {
        return Ok(key);
    }
    if let Some(key) = legacy_keychain_key() {
        store(app, &key).map_err(KeyError::Storage)?;
        if let Err(error) = forget_legacy_keychain() {
            eprintln!("forget migrated Hermes keychain entry: {error}");
        }
        return Ok(key);
    }
    if let Some(key) = config.api_key.as_deref().and_then(super::normalize_api_key) {
        store(app, &key).map_err(KeyError::Storage)?;
        return Ok(key);
    }
    Err(KeyError::Missing)
}

pub fn store(app: &tauri::AppHandle, value: &str) -> Result<(), String> {
    let key = super::normalize_api_key(value).ok_or_else(|| "API key is empty".to_string())?;
    let broker = CredentialBroker::for_app(app)?;
    broker.save(&CredentialId::agent(), &key)
}

pub fn forget(app: &tauri::AppHandle) -> Result<(), String> {
    CredentialBroker::for_app(app)?.forget(&CredentialId::agent())?;
    if let Err(error) = forget_legacy_keychain() {
        eprintln!("forget legacy Hermes keychain entry: {error}");
    }
    Ok(())
}

fn forget_legacy_keychain() -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("open agent credential: {e}"))?;
    match entry.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete agent credential: {e}")),
    }
}

fn legacy_keychain_key() -> Option<String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .ok()?
        .get_password()
        .ok()
        .and_then(|value| super::normalize_api_key(&value))
}

pub fn source(app: &tauri::AppHandle, config: &HermesConfigMeta) -> CredentialSource {
    if env_key().is_some() || read_env_local().ok().flatten().is_some() {
        return CredentialSource::Environment;
    }
    if hermes_home(app)
        .and_then(|home| discover_hermes_key(&home, &config.base_url, &config.model))
        .is_some()
    {
        return CredentialSource::Hermes;
    }
    if uses_default_profile(config) {
        return CredentialSource::Missing;
    }
    if CredentialBroker::for_app(app)
        .and_then(|broker| broker.resolve(&CredentialId::agent()))
        .ok()
        .flatten()
        .is_some()
        || config.api_key_configured
    {
        return CredentialSource::Stored;
    }
    CredentialSource::Missing
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

fn hermes_home(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Some(path);
    }
    app.path().home_dir().ok().map(|home| home.join(".hermes"))
}

fn discover_hermes_key(home: &Path, base_url: &str, model: &str) -> Option<String> {
    let target_port = local_base_port(base_url)?;
    if is_default_profile_connection(base_url, model) {
        return hermes_key_for_port(&home.join(".env"), target_port);
    }

    let mut candidates = Vec::new();
    if let Some(active) = active_profile(home) {
        if active == "default" {
            push_candidate(&mut candidates, home.join(".env"));
        } else {
            push_profile_candidate(home, &active, &mut candidates);
        }
    }
    if safe_profile_name(model) {
        push_profile_candidate(home, model, &mut candidates);
    }
    push_candidate(&mut candidates, home.join(".env"));

    let profiles = home.join("profiles");
    if is_real_directory(&profiles) {
        if let Ok(entries) = fs::read_dir(&profiles) {
            let mut profile_paths: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .take(MAX_HERMES_PROFILES)
                .map(|entry| entry.path().join(".env"))
                .collect();
            profile_paths.sort();
            for path in profile_paths {
                push_candidate(&mut candidates, path);
            }
        }
    }

    candidates
        .into_iter()
        .find_map(|path| hermes_key_for_port(&path, target_port))
}

fn hermes_key_for_port(path: &Path, target_port: u16) -> Option<String> {
    let content = read_bounded_regular(path, MAX_ENV_FILE_BYTES)?;
    let port = parse_env_content(&content, "API_SERVER_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8642);
    if port != target_port {
        return None;
    }
    parse_env_content(&content, "API_SERVER_KEY").and_then(|value| super::normalize_api_key(&value))
}

fn active_profile(home: &Path) -> Option<String> {
    let profile = read_bounded_regular(&home.join("active_profile"), MAX_ACTIVE_PROFILE_BYTES)?;
    let profile = profile.trim();
    safe_profile_name(profile).then(|| profile.to_string())
}

fn push_profile_candidate(home: &Path, profile: &str, candidates: &mut Vec<PathBuf>) {
    if !safe_profile_name(profile) {
        return;
    }
    let profiles = home.join("profiles");
    let profile_dir = profiles.join(profile);
    if is_real_directory(&profiles) && is_real_directory(&profile_dir) {
        push_candidate(candidates, profile_dir.join(".env"));
    }
}

fn push_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !candidates.contains(&path) {
        candidates.push(path);
    }
}

fn local_base_port(base_url: &str) -> Option<u16> {
    let parsed = reqwest::Url::parse(base_url).ok()?;
    let host = parsed.host_str()?;
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .ok()
            .is_some_and(|address| address.is_loopback());
    loopback.then(|| parsed.port_or_known_default()).flatten()
}

fn safe_profile_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && value != "."
        && value != ".."
}

fn parse_env_var(path: &Path, key: &str) -> Option<String> {
    let content = read_bounded_regular(path, MAX_ENV_FILE_BYTES)?;
    parse_env_content(&content, key)
}

fn parse_env_content(content: &str, key: &str) -> Option<String> {
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

fn is_real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

fn read_bounded_regular(path: &Path, max_bytes: u64) -> Option<String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return None;
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > max_bytes {
        return None;
    }
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
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

    #[test]
    fn discovers_the_matching_local_hermes_profile_without_paste() {
        let temp = tempfile::TempDir::new().unwrap();
        let root_profile = temp.path().join(".env");
        let cadence = temp.path().join("profiles/cadence");
        let motif = temp.path().join("profiles/motif");
        fs::create_dir_all(&cadence).unwrap();
        fs::create_dir_all(&motif).unwrap();
        fs::write(temp.path().join("active_profile"), "motif\n").unwrap();
        fs::write(
            root_profile,
            "API_SERVER_PORT=8642\nAPI_SERVER_KEY=root-secret\n",
        )
        .unwrap();
        fs::write(
            cadence.join(".env"),
            "API_SERVER_PORT=8644\nAPI_SERVER_KEY=Bearer cadence-secret\n",
        )
        .unwrap();
        fs::write(
            motif.join(".env"),
            "API_SERVER_PORT=8644\nAPI_SERVER_KEY=Bearer motif-secret\n",
        )
        .unwrap();

        assert_eq!(
            discover_hermes_key(temp.path(), "http://127.0.0.1:8644/v1", "cadence").as_deref(),
            Some("motif-secret")
        );
        assert_eq!(
            discover_hermes_key(temp.path(), "http://127.0.0.1:8642/v1", "hermes-agent").as_deref(),
            Some("root-secret")
        );
        assert_eq!(
            discover_hermes_key(temp.path(), "https://agent.example.com/v1", "cadence"),
            None
        );
        assert_eq!(local_base_port("not a URL"), None);
    }

    #[test]
    fn default_profile_key_wins_when_an_active_profile_reuses_its_port() {
        let temp = tempfile::TempDir::new().unwrap();
        let active = temp.path().join("profiles/active-custom");
        fs::create_dir_all(&active).unwrap();
        fs::write(temp.path().join("active_profile"), "active-custom\n").unwrap();
        fs::write(
            temp.path().join(".env"),
            "API_SERVER_PORT=8642\nAPI_SERVER_KEY=default-secret\n",
        )
        .unwrap();
        fs::write(
            active.join(".env"),
            "API_SERVER_PORT=8642\nAPI_SERVER_KEY=custom-secret\n",
        )
        .unwrap();

        assert_eq!(
            discover_hermes_key(temp.path(), "http://127.0.0.1:8642/v1", "hermes-agent").as_deref(),
            Some("default-secret")
        );
    }

    #[test]
    fn default_profile_does_not_borrow_a_custom_profile_key() {
        let temp = tempfile::TempDir::new().unwrap();
        let active = temp.path().join("profiles/active-custom");
        fs::create_dir_all(&active).unwrap();
        fs::write(temp.path().join("active_profile"), "active-custom\n").unwrap();
        fs::write(
            active.join(".env"),
            "API_SERVER_PORT=8642\nAPI_SERVER_KEY=custom-secret\n",
        )
        .unwrap();

        assert_eq!(
            discover_hermes_key(
                temp.path(),
                crate::agent::DEFAULT_BASE_URL,
                crate::agent::DEFAULT_MODEL,
            ),
            None
        );
    }

    #[test]
    fn only_the_exact_default_connection_uses_default_profile_policy() {
        assert!(is_default_profile_connection(
            crate::agent::DEFAULT_BASE_URL,
            crate::agent::DEFAULT_MODEL
        ));
        assert!(!is_default_profile_connection(
            "http://127.0.0.1:8644/v1",
            crate::agent::DEFAULT_MODEL
        ));
        assert!(!is_default_profile_connection(
            crate::agent::DEFAULT_BASE_URL,
            "custom-agent"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn local_hermes_discovery_refuses_symlinks_and_oversized_env_files() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        fs::write(
            outside.path().join(".env"),
            "API_SERVER_PORT=8644\nAPI_SERVER_KEY=outside-secret\n",
        )
        .unwrap();
        fs::create_dir_all(temp.path().join("profiles")).unwrap();
        symlink(outside.path(), temp.path().join("profiles/cadence")).unwrap();
        fs::write(temp.path().join("active_profile"), "cadence\n").unwrap();

        assert_eq!(
            discover_hermes_key(temp.path(), "http://127.0.0.1:8644/v1", "cadence"),
            None
        );

        fs::write(
            temp.path().join(".env"),
            vec![b'x'; MAX_ENV_FILE_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(
            discover_hermes_key(temp.path(), "http://127.0.0.1:8642/v1", "default"),
            None
        );
    }
}
