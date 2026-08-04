use super::{uses_default_profile, CredentialSource, HermesConfigMeta, ManagedHermesProfile};
use crate::credentials::{CredentialBroker, CredentialId};
use keyring::Entry;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read};
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
    #[error(
        "The active Hermes profile could not be read safely. Check it in Hermes, then try again."
    )]
    ProfileUnavailable,
    #[error("{0}")]
    Storage(String),
}

pub struct ResolvedConnection {
    pub config: HermesConfigMeta,
    pub api_key: String,
    pub managed_profile: Option<ManagedHermesProfile>,
}

struct ManagedProfileSelection {
    profile: ManagedHermesProfile,
    api_key: Option<String>,
}

pub fn resolve_connection(
    app: &tauri::AppHandle,
    config: &HermesConfigMeta,
) -> Result<ResolvedConnection, KeyError> {
    let managed = uses_default_profile(config);
    let (runtime_config, hermes_key, managed_profile) = match hermes_home(app) {
        Some(home) if managed => {
            let selection = managed_profile_for_home(&home);
            if !selection.profile.available {
                return Err(KeyError::ProfileUnavailable);
            }
            let mut runtime = config.clone();
            runtime.base_url = format!("http://127.0.0.1:{}/v1", selection.profile.port);
            runtime.model = selection.profile.model.clone();
            let profile = selection.profile;
            (runtime, selection.api_key, Some(profile))
        }
        Some(home) => (
            config.clone(),
            discover_hermes_key(&home, &config.base_url, &config.model),
            None,
        ),
        None if managed => {
            let profile = default_managed_profile();
            (config.clone(), None, Some(profile))
        }
        None => (config.clone(), None, None),
    };

    let api_key = if let Some(key) = env_key() {
        key
    } else if let Some(key) = read_env_local()? {
        key
    } else if let Some(key) = hermes_key {
        key
    } else if managed {
        return Err(KeyError::Missing);
    } else {
        let broker = CredentialBroker::for_app(app).map_err(KeyError::Storage)?;
        if let Some(key) = broker
            .resolve(&CredentialId::agent())
            .map_err(KeyError::Storage)?
            .and_then(|value| super::normalize_api_key(&value))
        {
            key
        } else if let Some(key) = legacy_keychain_key() {
            store(app, &key).map_err(KeyError::Storage)?;
            if let Err(error) = forget_legacy_keychain() {
                eprintln!("forget migrated Hermes keychain entry: {error}");
            }
            key
        } else if let Some(key) = config.api_key.as_deref().and_then(super::normalize_api_key) {
            store(app, &key).map_err(KeyError::Storage)?;
            key
        } else {
            return Err(KeyError::Missing);
        }
    };

    Ok(ResolvedConnection {
        config: runtime_config,
        api_key,
        managed_profile,
    })
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

pub fn describe(
    app: &tauri::AppHandle,
    config: &HermesConfigMeta,
) -> (CredentialSource, Option<ManagedHermesProfile>) {
    let environment_key = env_key().is_some() || read_env_local().ok().flatten().is_some();
    if uses_default_profile(config) {
        let selection = hermes_home(app)
            .map(|home| managed_profile_for_home(&home))
            .unwrap_or_else(|| ManagedProfileSelection {
                profile: default_managed_profile(),
                api_key: None,
            });
        let source = if environment_key {
            CredentialSource::Environment
        } else if selection.profile.available && selection.api_key.is_some() {
            CredentialSource::Hermes
        } else {
            CredentialSource::Missing
        };
        return (source, Some(selection.profile));
    }

    if environment_key {
        return (CredentialSource::Environment, None);
    }
    let hermes_key = hermes_home(app)
        .and_then(|home| discover_hermes_key(&home, &config.base_url, &config.model));
    if hermes_key.is_some() {
        return (CredentialSource::Hermes, None);
    }
    if CredentialBroker::for_app(app)
        .and_then(|broker| broker.resolve(&CredentialId::agent()))
        .ok()
        .flatten()
        .is_some()
        || config.api_key_configured
    {
        return (CredentialSource::Stored, None);
    }
    (CredentialSource::Missing, None)
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

fn managed_profile_for_home(home: &Path) -> ManagedProfileSelection {
    match selected_profile(home) {
        Ok(Some(name)) if name != "default" => {
            let Some(root) = profile_root_path(home, &name) else {
                return unavailable_managed_profile(&name);
            };
            read_managed_profile(&root, &name).unwrap_or_else(|| unavailable_managed_profile(&name))
        }
        Ok(Some(_)) | Ok(None) => read_managed_profile(home, "default")
            .unwrap_or_else(|| unavailable_managed_profile("default")),
        Err(()) => unavailable_managed_profile("active"),
    }
}

fn profile_root_path(home: &Path, profile: &str) -> Option<PathBuf> {
    let profiles = home.join("profiles");
    let profile_dir = profiles.join(profile);
    (is_real_directory(&profiles) && is_real_directory(&profile_dir)).then_some(profile_dir)
}

fn read_managed_profile(root: &Path, name: &str) -> Option<ManagedProfileSelection> {
    let env = read_optional_bounded_regular(&root.join(".env"), MAX_ENV_FILE_BYTES).ok()?;
    let yaml = read_optional_bounded_regular(&root.join("config.yaml"), MAX_ENV_FILE_BYTES).ok()?;
    if name != "default" && env.is_none() && yaml.is_none() {
        return None;
    }
    let yaml_settings = yaml
        .as_deref()
        .map(parse_yaml_api_server_settings)
        .transpose()
        .ok()?
        .flatten()
        .unwrap_or_default();
    let env_port = match env
        .as_deref()
        .and_then(|content| parse_env_content(content, "API_SERVER_PORT"))
    {
        Some(value) => Some(parse_profile_port(&value)?),
        None => None,
    };
    let port = env_port.or(yaml_settings.port).unwrap_or(8642);
    let model = env
        .as_deref()
        .and_then(|content| parse_env_content(content, "API_SERVER_MODEL_NAME"))
        .filter(|value| !value.trim().is_empty())
        .or(yaml_settings.model)
        .unwrap_or_else(|| managed_model_name(name));
    let api_key = env
        .as_deref()
        .and_then(|content| parse_env_content(content, "API_SERVER_KEY"))
        .and_then(|value| super::normalize_api_key(&value))
        .or(yaml_settings.api_key);
    Some(ManagedProfileSelection {
        profile: ManagedHermesProfile {
            name: name.to_string(),
            port,
            model,
            available: true,
        },
        api_key,
    })
}

fn unavailable_managed_profile(name: &str) -> ManagedProfileSelection {
    ManagedProfileSelection {
        profile: ManagedHermesProfile {
            name: name.to_string(),
            port: 8642,
            model: managed_model_name(name),
            available: false,
        },
        api_key: None,
    }
}

fn default_managed_profile() -> ManagedHermesProfile {
    ManagedHermesProfile {
        name: "default".to_string(),
        port: 8642,
        model: crate::agent::DEFAULT_MODEL.to_string(),
        available: true,
    }
}

fn managed_model_name(profile_name: &str) -> String {
    if matches!(profile_name, "default" | "custom") {
        crate::agent::DEFAULT_MODEL.to_string()
    } else {
        profile_name.to_string()
    }
}

#[derive(Default)]
struct ApiServerSettings {
    port: Option<u16>,
    model: Option<String>,
    api_key: Option<String>,
}

fn parse_yaml_api_server_settings(content: &str) -> Result<Option<ApiServerSettings>, ()> {
    let value: serde_yaml::Value = serde_yaml::from_str(content).map_err(|_| ())?;
    let port = match yaml_api_server_value(&value, "port") {
        None => None,
        Some(serde_yaml::Value::Number(number)) => {
            let value = number.as_u64().ok_or(())?;
            Some(parse_profile_port(&value.to_string()).ok_or(())?)
        }
        Some(serde_yaml::Value::String(value)) => Some(parse_profile_port(value).ok_or(())?),
        Some(_) => return Err(()),
    };
    let model = yaml_api_server_value(&value, "model_name")
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    let api_key = yaml_api_server_value(&value, "key")
        .and_then(serde_yaml::Value::as_str)
        .and_then(super::normalize_api_key);
    Ok(Some(ApiServerSettings {
        port,
        model,
        api_key,
    }))
}

fn parse_profile_port(value: &str) -> Option<u16> {
    value.parse::<u16>().ok().filter(|port| *port > 0)
}

fn yaml_api_server_value<'a>(
    value: &'a serde_yaml::Value,
    field: &str,
) -> Option<&'a serde_yaml::Value> {
    [
        &["gateway", "api_server", "extra", field][..],
        &["gateway", "api_server", field][..],
        &["platforms", "api_server", "extra", field][..],
        &["platforms", "api_server", field][..],
        &["gateway", "platforms", "api_server", "extra", field][..],
        &["gateway", "platforms", "api_server", field][..],
    ]
    .into_iter()
    .find_map(|path| yaml_path(value, path))
}

fn yaml_path<'a>(mut value: &'a serde_yaml::Value, path: &[&str]) -> Option<&'a serde_yaml::Value> {
    for key in path {
        value = value
            .as_mapping()?
            .get(serde_yaml::Value::String((*key).to_string()))?;
    }
    Some(value)
}

fn discover_hermes_key(home: &Path, base_url: &str, model: &str) -> Option<String> {
    let target_port = local_base_port(base_url)?;
    let mut candidates = Vec::new();
    if let Some(active) = active_profile(home) {
        if active == "default" {
            push_candidate(&mut candidates, home.to_path_buf());
        } else {
            push_profile_candidate(home, &active, &mut candidates);
        }
    }
    if safe_profile_name(model) {
        push_profile_candidate(home, model, &mut candidates);
    }
    push_candidate(&mut candidates, home.to_path_buf());

    let profiles = home.join("profiles");
    if is_real_directory(&profiles) {
        if let Ok(entries) = fs::read_dir(&profiles) {
            let mut profile_paths: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .take(MAX_HERMES_PROFILES)
                .map(|entry| entry.path())
                .collect();
            profile_paths.sort();
            for path in profile_paths {
                push_candidate(&mut candidates, path);
            }
        }
    }

    candidates
        .into_iter()
        .find_map(|root| hermes_key_for_port(&root, target_port))
}

fn hermes_key_for_port(root: &Path, target_port: u16) -> Option<String> {
    let selection = read_managed_profile(root, "custom")?;
    if selection.profile.port != target_port {
        return None;
    }
    selection.api_key
}

fn active_profile(home: &Path) -> Option<String> {
    selected_profile(home).ok().flatten()
}

fn selected_profile(home: &Path) -> Result<Option<String>, ()> {
    let Some(profile) =
        read_optional_bounded_regular(&home.join("active_profile"), MAX_ACTIVE_PROFILE_BYTES)?
    else {
        return Ok(None);
    };
    let profile = profile.trim();
    safe_profile_name(profile)
        .then(|| Some(profile.to_string()))
        .ok_or(())
}

fn push_profile_candidate(home: &Path, profile: &str, candidates: &mut Vec<PathBuf>) {
    if !safe_profile_name(profile) {
        return;
    }
    let profiles = home.join("profiles");
    let profile_dir = profiles.join(profile);
    if is_real_directory(&profiles) && is_real_directory(&profile_dir) {
        push_candidate(candidates, profile_dir);
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

fn read_optional_bounded_regular(path: &Path, max_bytes: u64) -> Result<Option<String>, ()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
        Ok(metadata) if metadata.is_file() => {
            read_bounded_regular(path, max_bytes).map(Some).ok_or(())
        }
        Ok(_) => Err(()),
    }
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
        let focus = temp.path().join("profiles/focus");
        let review = temp.path().join("profiles/review");
        fs::create_dir_all(&focus).unwrap();
        fs::create_dir_all(&review).unwrap();
        fs::write(temp.path().join("active_profile"), "review\n").unwrap();
        fs::write(
            root_profile,
            "API_SERVER_PORT=8642\nAPI_SERVER_KEY=root-secret\n",
        )
        .unwrap();
        fs::write(
            focus.join(".env"),
            "API_SERVER_PORT=8651\nAPI_SERVER_KEY=Bearer focus-secret\n",
        )
        .unwrap();
        fs::write(
            review.join(".env"),
            "API_SERVER_PORT=8651\nAPI_SERVER_KEY=Bearer review-secret\n",
        )
        .unwrap();

        assert_eq!(
            discover_hermes_key(temp.path(), "http://127.0.0.1:8651/v1", "focus").as_deref(),
            Some("review-secret")
        );
        assert_eq!(
            discover_hermes_key(temp.path(), "http://127.0.0.1:8642/v1", "hermes-agent").as_deref(),
            Some("root-secret")
        );
        assert_eq!(
            discover_hermes_key(temp.path(), "https://agent.example.com/v1", "focus"),
            None
        );
        assert_eq!(local_base_port("not a URL"), None);
    }

    #[test]
    fn managed_connection_follows_the_active_profile_port_and_key() {
        let temp = tempfile::TempDir::new().unwrap();
        let active = temp.path().join("profiles/focus");
        let next = temp.path().join("profiles/review");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&next).unwrap();
        fs::write(temp.path().join("active_profile"), "focus\n").unwrap();
        fs::write(
            temp.path().join(".env"),
            "API_SERVER_PORT=8642\nAPI_SERVER_KEY=default-secret\n",
        )
        .unwrap();
        fs::write(
            active.join(".env"),
            "API_SERVER_PORT=8651\nAPI_SERVER_MODEL_NAME=focus-gateway\nAPI_SERVER_KEY=active-secret\n",
        )
        .unwrap();
        fs::write(
            next.join(".env"),
            "API_SERVER_PORT=8653\nAPI_SERVER_KEY=next-secret\n",
        )
        .unwrap();

        let selection = managed_profile_for_home(temp.path());
        assert_eq!(selection.api_key.as_deref(), Some("active-secret"));
        let profile = selection.profile;
        assert_eq!(
            profile,
            ManagedHermesProfile {
                name: "focus".to_string(),
                port: 8651,
                model: "focus-gateway".to_string(),
                available: true,
            }
        );
        assert_eq!(profile.model, "focus-gateway");

        fs::write(temp.path().join("active_profile"), "review\n").unwrap();
        let selection = managed_profile_for_home(temp.path());
        assert_eq!(selection.api_key.as_deref(), Some("next-secret"));
        let profile = selection.profile;
        assert_eq!(
            profile,
            ManagedHermesProfile {
                name: "review".to_string(),
                port: 8653,
                model: "review".to_string(),
                available: true,
            }
        );
    }

    #[test]
    fn managed_connection_uses_default_only_without_a_named_profile() {
        let temp = tempfile::TempDir::new().unwrap();
        fs::write(
            temp.path().join(".env"),
            "API_SERVER_PORT=8652\nAPI_SERVER_KEY=default-secret\n",
        )
        .unwrap();

        let selection = managed_profile_for_home(temp.path());
        assert_eq!(selection.api_key.as_deref(), Some("default-secret"));
        let profile = selection.profile;
        assert_eq!(
            profile,
            ManagedHermesProfile {
                name: "default".to_string(),
                port: 8652,
                model: crate::agent::DEFAULT_MODEL.to_string(),
                available: true,
            }
        );
        assert_eq!(profile.model, crate::agent::DEFAULT_MODEL);

        fs::write(temp.path().join("active_profile"), "missing-profile\n").unwrap();
        let selection = managed_profile_for_home(temp.path());
        assert_eq!(selection.profile.name, "missing-profile");
        assert!(!selection.profile.available);
        assert!(selection.api_key.is_none());
    }

    #[test]
    fn managed_connection_reads_config_yaml_with_env_precedence() {
        let temp = tempfile::TempDir::new().unwrap();
        let profile = temp.path().join("profiles/focus");
        fs::create_dir_all(&profile).unwrap();
        fs::write(temp.path().join("active_profile"), "focus\n").unwrap();
        fs::write(
            profile.join("config.yaml"),
            "platforms:\n  api_server:\n    extra:\n      port: 8650\n      model_name: yaml-gateway\n      key: yaml-secret\n",
        )
        .unwrap();

        let selection = managed_profile_for_home(temp.path());
        assert_eq!(selection.profile.port, 8650);
        assert_eq!(selection.profile.model, "yaml-gateway");
        assert_eq!(selection.api_key.as_deref(), Some("yaml-secret"));
        assert_eq!(
            discover_hermes_key(temp.path(), "http://127.0.0.1:8650/v1", "focus").as_deref(),
            Some("yaml-secret")
        );

        fs::write(
            profile.join(".env"),
            "API_SERVER_PORT=8651\nAPI_SERVER_MODEL_NAME=env-gateway\nAPI_SERVER_KEY=env-secret\n",
        )
        .unwrap();
        let selection = managed_profile_for_home(temp.path());
        assert_eq!(selection.profile.port, 8651);
        assert_eq!(selection.profile.model, "env-gateway");
        assert_eq!(selection.api_key.as_deref(), Some("env-secret"));
    }

    #[test]
    fn managed_connection_rejects_malformed_or_out_of_range_ports() {
        let temp = tempfile::TempDir::new().unwrap();
        let env_profile = temp.path().join("profiles/focus");
        fs::create_dir_all(&env_profile).unwrap();
        fs::write(temp.path().join("active_profile"), "focus\n").unwrap();
        fs::write(
            env_profile.join(".env"),
            "API_SERVER_PORT=not-a-port\nAPI_SERVER_KEY=env-secret\n",
        )
        .unwrap();

        let selection = managed_profile_for_home(temp.path());
        assert!(!selection.profile.available);
        assert!(selection.api_key.is_none());

        let yaml_profile = temp.path().join("profiles/review");
        fs::create_dir_all(&yaml_profile).unwrap();
        fs::write(temp.path().join("active_profile"), "review\n").unwrap();
        fs::write(
            yaml_profile.join("config.yaml"),
            "platforms:\n  api_server:\n    extra:\n      port: 70000\n      key: yaml-secret\n",
        )
        .unwrap();

        let selection = managed_profile_for_home(temp.path());
        assert!(!selection.profile.available);
        assert!(selection.api_key.is_none());
    }

    #[test]
    fn only_the_exact_default_connection_uses_default_profile_policy() {
        assert!(crate::agent::is_default_profile_connection(
            crate::agent::DEFAULT_BASE_URL,
            crate::agent::DEFAULT_MODEL
        ));
        assert!(!crate::agent::is_default_profile_connection(
            "http://127.0.0.1:8644/v1",
            crate::agent::DEFAULT_MODEL
        ));
        assert!(!crate::agent::is_default_profile_connection(
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
        symlink(outside.path(), temp.path().join("profiles/linked-profile")).unwrap();
        fs::write(temp.path().join("active_profile"), "linked-profile\n").unwrap();

        assert_eq!(
            discover_hermes_key(temp.path(), "http://127.0.0.1:8644/v1", "linked-profile"),
            None
        );
        let selection = managed_profile_for_home(temp.path());
        assert!(!selection.profile.available);

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
