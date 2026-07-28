// Config commands: vault path, profile, theme, dismissed warnings.
//
// All app-level configuration lives in a single tauri-plugin-store file
// (config.json under tauri's app-data dir, NOT inside the vault).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";
const LEGACY_CLEANUP_MARKER: &str = "legacy_cleanup_v1";
const LEGACY_CREDENTIAL_SERVICE: &str = "Woodshed Transcription";
const LEGACY_CREDENTIAL_ACCOUNT: &str = "deepgram";

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
