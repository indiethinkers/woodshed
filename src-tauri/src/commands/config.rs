// Config commands: vault path, profile, theme, dismissed warnings.
//
// All app-level configuration lives in a single tauri-plugin-store file
// (config.json under tauri's app-data dir, NOT inside the vault).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";

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
