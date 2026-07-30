// Config commands: vault path, profile, theme, dismissed warnings.
//
// All app-level configuration lives in a single tauri-plugin-store file
// (config.json under tauri's app-data dir, NOT inside the vault).

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";
const DEMO_CLOCK_FILE: &str = "demo-clock.json";
const MAX_DEMO_CLOCK_BYTES: u64 = 4 * 1024;
const LEGACY_CLEANUP_MARKER: &str = "legacy_cleanup_v1";
const LEGACY_CREDENTIAL_SERVICE: &str = "Woodshed Transcription";
const LEGACY_CREDENTIAL_ACCOUNT: &str = "deepgram";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DemoClockFile {
    vault_path: String,
    now: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DemoClock {
    pub now: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Profile {
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub theme: Theme,
}

/// Remove state left by the retired transcription integration. This runs at
/// startup until the keychain deletion succeeds, then records a generic
/// migration marker so subsequent launches do not keep touching Keychain.
pub(crate) fn cleanup_removed_integration(app: &AppHandle) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let store_changed = store.delete("voice");
    if store
        .get(LEGACY_CLEANUP_MARKER)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        if store_changed {
            store.save().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let entry = keyring::Entry::new(LEGACY_CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_ACCOUNT)
        .map_err(|error| format!("open obsolete credential: {error}"))?;
    match entry.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(format!("delete obsolete credential: {error}")),
    }

    store.set(LEGACY_CLEANUP_MARKER, serde_json::Value::Bool(true));
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_path_get(app: AppHandle) -> Result<Option<String>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    Ok(store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from)))
}

#[tauri::command]
pub fn vault_path_set(app: AppHandle, path: String) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set("vault_path", serde_json::Value::String(path));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Return an optional developer-demo clock from app data.
///
/// The file names the one vault it applies to. Switching to any other vault
/// restores the system clock without mutating either vault.
#[tauri::command]
pub fn demo_clock_get(app: AppHandle) -> Result<Option<DemoClock>, String> {
    let Some(vault_path) = vault_path_get(app.clone())? else {
        return Ok(None);
    };
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "resolve app data for demo clock".to_string())?;
    read_demo_clock(&app_data.join(DEMO_CLOCK_FILE), Path::new(&vault_path))
}

fn read_demo_clock(path: &Path, current_vault: &Path) -> Result<Option<DemoClock>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("inspect demo clock".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("demo clock must be a regular file".to_string());
    }
    if metadata.len() > MAX_DEMO_CLOCK_BYTES {
        return Err("demo clock exceeds byte limit".to_string());
    }

    let raw = crate::vault::read_record(path).map_err(|_| "read demo clock".to_string())?;
    let file: DemoClockFile =
        serde_json::from_str(&raw).map_err(|_| "parse demo clock".to_string())?;
    chrono::DateTime::parse_from_rfc3339(&file.now)
        .map_err(|_| "demo clock now must be an RFC 3339 timestamp".to_string())?;

    let configured = current_vault.canonicalize().ok();
    let scoped = Path::new(&file.vault_path).canonicalize().ok();
    if configured.is_none() || configured != scoped {
        return Ok(None);
    }

    Ok(Some(DemoClock { now: file.now }))
}

#[tauri::command]
pub fn profile_get(app: AppHandle) -> Result<Profile, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    match store.get("profile") {
        Some(val) => serde_json::from_value(val).map_err(|e| e.to_string()),
        None => Ok(Profile::default()),
    }
}

#[tauri::command]
pub fn profile_set(app: AppHandle, profile: Profile) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(&profile).map_err(|e| e.to_string())?;
    store.set("profile", value);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn warning_dismissed_get(app: AppHandle, key: String) -> Result<bool, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let dismissed = store
        .get("dismissed_warnings")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    Ok(dismissed.iter().any(|v| v.as_str() == Some(&key)))
}

#[tauri::command]
pub fn warning_dismiss(app: AppHandle, key: String) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut dismissed = store
        .get("dismissed_warnings")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    if !dismissed.iter().any(|v| v.as_str() == Some(&key)) {
        dismissed.push(serde_json::Value::String(key));
        store.set("dismissed_warnings", serde_json::Value::Array(dismissed));
        store.save().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resolves the default vault path. ~/woodshed/ for non-test contexts.
/// Used by the /welcome screen as the prefill value.
#[tauri::command]
pub fn vault_path_default(app: AppHandle) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("resolve home dir: {}", e))?;
    Ok(home.join("woodshed").to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn clock_json(vault: &Path) -> String {
        serde_json::json!({
            "vaultPath": vault,
            "now": "2026-10-12T13:15:00-07:00"
        })
        .to_string()
    }

    #[test]
    fn demo_clock_is_optional_scoped_and_validated() {
        let tmp = TempDir::new().unwrap();
        let current = tmp.path().join("current-vault");
        let other = tmp.path().join("other-vault");
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&other).unwrap();
        let path = tmp.path().join(DEMO_CLOCK_FILE);

        assert_eq!(read_demo_clock(&path, &current).unwrap(), None);

        fs::write(&path, clock_json(&current)).unwrap();
        assert_eq!(
            read_demo_clock(&path, &current).unwrap(),
            Some(DemoClock {
                now: "2026-10-12T13:15:00-07:00".to_string(),
            })
        );
        assert_eq!(read_demo_clock(&path, &other).unwrap(), None);

        fs::write(&path, r#"{"vaultPath":"x","now":"not-a-timestamp"}"#).unwrap();
        assert!(read_demo_clock(&path, &current).is_err());
    }

    #[test]
    fn demo_clock_rejects_oversized_files() {
        let tmp = TempDir::new().unwrap();
        let current = tmp.path().join("vault");
        fs::create_dir_all(&current).unwrap();
        let path = tmp.path().join(DEMO_CLOCK_FILE);
        fs::write(&path, vec![b'x'; MAX_DEMO_CLOCK_BYTES as usize + 1]).unwrap();

        assert!(read_demo_clock(&path, &current).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn demo_clock_rejects_a_symlinked_file() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let current = tmp.path().join("vault");
        fs::create_dir_all(&current).unwrap();
        let outside = tmp.path().join("outside.json");
        fs::write(&outside, clock_json(&current)).unwrap();
        let path = tmp.path().join(DEMO_CLOCK_FILE);
        symlink(outside, &path).unwrap();

        assert!(read_demo_clock(&path, &current).is_err());
    }
}
