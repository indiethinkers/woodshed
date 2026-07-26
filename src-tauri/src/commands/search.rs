// Search commands: thin wrappers around the FTS5 index. The index itself
// lives in `crate::index` and is opened lazily via `AppState::ensure_index`.
//
// `search` is the hot-path call that the command palette hits on every
// keystroke. `vault_reindex` is the recovery hatch wired to the
// "Reset & re-scan" button — it wipes the index and rebuilds from the
// vault on disk.

use crate::index::{BacklinkEntry, OutgoingLinkEntry, SearchHit, WikilinkTargetRow};
use crate::AppState;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";
const DEFAULT_LIMIT: usize = 30;
const MAX_LIMIT: usize = 200;

#[tauri::command]
pub async fn search(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let handle = state.ensure_index(&app)?;
    let cap = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    handle
        .search(trimmed, cap)
        .map_err(|e| format!("search: {}", e))
}

/// Bulk listing of every wikilink-resolvable target in the vault. The frontend
/// caches this in React Query and uses it to determine whether each `[[name]]`
/// resolves to an existing record (solid underline) or is unresolved (dotted
/// underline placeholder). Cache is invalidated on `vault:changed` events.
#[tauri::command]
pub fn wikilink_targets(
    app: AppHandle,
    state: State<AppState>,
) -> Result<Vec<WikilinkTargetRow>, String> {
    let handle = state.ensure_index(&app)?;
    handle
        .list_wikilink_targets()
        .map_err(|e| format!("list_wikilink_targets: {}", e))
}

#[tauri::command]
pub async fn wikilink_backlinks(
    app: AppHandle,
    state: State<'_, AppState>,
    target: String,
) -> Result<Vec<BacklinkEntry>, String> {
    let handle = state.ensure_index(&app)?;
    handle
        .backlinks_for_target(&target)
        .map_err(|e| format!("wikilink_backlinks: {}", e))
}

#[tauri::command]
pub async fn wikilink_outgoing(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
) -> Result<Vec<OutgoingLinkEntry>, String> {
    let handle = state.ensure_index(&app)?;
    handle
        .outgoing_links_for_source(&source)
        .map_err(|e| format!("wikilink_outgoing: {}", e))
}

#[tauri::command]
pub fn vault_reindex(app: AppHandle, state: State<AppState>) -> Result<usize, String> {
    let vault = vault_root(&app)?;
    let handle = state.ensure_index(&app)?;
    handle
        .rebuild_from_vault(&vault)
        .map_err(|e| format!("rebuild: {}", e))
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}
