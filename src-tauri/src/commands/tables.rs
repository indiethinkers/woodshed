// Tables commands. A table is a folder under vault/tables/<id>/ holding a
// _schema.md (frontmatter: name, columns, views) plus one sidecar per row
// (<row-id>.md). Cells are keyed by column id (not name) so renames don't
// strand values.
//
// IDs:
//   - table id: slug(name) with -2/-3 collision suffix (filesystem path).
//   - column / view / option / row ids: ulid-prefixed (col_, view_, opt_, row_).

use crate::parsers::{self, Column, ColumnType, Row as ParsedRow, Table as ParsedTable, View};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;
use ulid::Ulid;

const STORE_FILE: &str = "config.json";
const SCHEMA_FILE: &str = "_schema.md";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDto {
    pub id: String,
    pub path: String,
    pub name: String,
    pub created: String,
    pub favorite: bool,
    pub columns: Vec<Column>,
    pub views: Vec<View>,
}

impl TableDto {
    pub(crate) fn from_parsed(table: ParsedTable, vault: &Path, abs_path: &Path) -> Self {
        let rel = abs_path
            .strip_prefix(vault)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| abs_path.to_string_lossy().to_string());
        TableDto {
            id: table.id,
            path: rel,
            name: table.name,
            created: table.created,
            favorite: table.favorite,
            columns: table.columns,
            views: table.views,
        }
    }
}

/// Lightweight summary used for the tables sidebar — avoids parsing every
/// row sidecar when we just need a list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub id: String,
    pub name: String,
    pub created: String,
    pub favorite: bool,
    pub row_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDto {
    pub id: String,
    pub path: String,
    pub table: String,
    pub created: String,
    pub sort_key: Option<f64>,
    pub cells: BTreeMap<String, serde_yaml::Value>,
    pub body: String,
}

impl RowDto {
    pub(crate) fn from_parsed(row: ParsedRow, vault: &Path, abs_path: &Path) -> Self {
        let rel = abs_path
            .strip_prefix(vault)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| abs_path.to_string_lossy().to_string());
        RowDto {
            id: row.id,
            path: rel,
            table: row.table,
            created: row.created,
            sort_key: row.sort_key,
            cells: row.cells,
            body: row.body,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCreate {
    pub name: String,
    #[serde(default)]
    pub columns: Option<Vec<Column>>,
    #[serde(default)]
    pub views: Option<Vec<View>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableUpdate {
    pub name: Option<String>,
    pub columns: Option<Vec<Column>>,
    pub views: Option<Vec<View>>,
    pub favorite: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCreate {
    #[serde(default)]
    pub cells: BTreeMap<String, serde_yaml::Value>,
    #[serde(default)]
    pub body: Option<String>,
}

/// Cell patch: keys present replace, keys absent preserve. Send `null` value
/// to clear a cell (we store nulls as YAML null and treat them as empty).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowUpdate {
    #[serde(default)]
    pub cells: Option<BTreeMap<String, serde_yaml::Value>>,
    #[serde(default)]
    pub body: Option<String>,
}

/// The complete row order for one table. Requiring the full set keeps a
/// filtered view from accidentally assigning positions to only a subset.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowReorder {
    pub row_ids: Vec<String>,
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

pub(crate) fn tables_root(vault: &Path) -> PathBuf {
    vault.join("tables")
}

pub(crate) fn table_dir(vault: &Path, id: &str) -> Result<PathBuf, String> {
    vault_lib::record_directory_path(vault, "tables", id)
}

pub(crate) fn schema_path(vault: &Path, id: &str) -> Result<PathBuf, String> {
    let dir = table_dir(vault, id)?;
    if dir.exists() {
        vault_lib::record_file_path_in(vault, &dir, "_schema")
    } else {
        Ok(dir.join(SCHEMA_FILE))
    }
}

pub(crate) fn row_path(vault: &Path, table_id: &str, row_id: &str) -> Result<PathBuf, String> {
    let dir = table_dir(vault, table_id)?;
    vault_lib::validate_record_id(row_id)?;
    if dir.exists() {
        vault_lib::record_file_path_in(vault, &dir, row_id)
    } else {
        Ok(dir.join(format!("{row_id}.md")))
    }
}

/// Slugify name into a filesystem-safe table id. Same rules as people.
fn slugify_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = true;
    for c in name.chars() {
        if c.is_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    if out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "table".to_string()
    } else {
        out
    }
}

fn unique_table_id(vault: &Path, base: &str) -> Result<String, String> {
    if !table_dir(vault, base)?.exists() {
        return Ok(base.to_string());
    }
    for n in 2..1000 {
        let candidate = format!("{}-{}", base, n);
        if !table_dir(vault, &candidate)?.exists() {
            return Ok(candidate);
        }
    }
    Ok(format!(
        "{}-{}",
        base,
        chrono::Utc::now().timestamp_millis()
    ))
}

fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn write_schema(
    state: &State<AppState>,
    abs_path: &Path,
    table: &ParsedTable,
) -> Result<(), String> {
    let serialized = parsers::serialize_table_schema(table).map_err(|e| e.to_string())?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &serialized).map_err(|e| e.to_string())
}

fn write_row(state: &State<AppState>, abs_path: &Path, row: &ParsedRow) -> Result<(), String> {
    let serialized = parsers::serialize_row(row).map_err(|e| e.to_string())?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &serialized).map_err(|e| e.to_string())
}

fn upsert_row_index(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    abs_path: &Path,
    row: &ParsedRow,
) {
    let Ok(idx) = state.ensure_index(app) else {
        return;
    };
    let rel = crate::index::rel_path_str(vault, abs_path);
    if let Err(e) = idx.upsert(&crate::index::doc_from_row(row, &rel)) {
        eprintln!("index row {} failed: {}", rel, e);
    }
}

fn delete_index_path(app: &AppHandle, state: &State<AppState>, vault: &Path, abs_path: &Path) {
    let Ok(idx) = state.ensure_index(app) else {
        return;
    };
    let rel = crate::index::rel_path_str(vault, abs_path);
    if let Err(e) = idx.delete_by_path(&rel) {
        eprintln!("delete index row {} failed: {}", rel, e);
    }
}

pub(crate) fn read_table(vault: &Path, abs_path: &Path) -> Result<TableDto, String> {
    let content = vault_lib::read_record(abs_path).map_err(|e| e.to_string())?;
    let parsed = parsers::parse_table_schema(&content).map_err(|e| format!("{:#}", e))?;
    Ok(TableDto::from_parsed(parsed, vault, abs_path))
}

pub(crate) fn read_row(vault: &Path, abs_path: &Path) -> Result<RowDto, String> {
    let content = vault_lib::read_record(abs_path).map_err(|e| e.to_string())?;
    let parsed = parsers::parse_row(&content).map_err(|e| format!("{:#}", e))?;
    Ok(RowDto::from_parsed(parsed, vault, abs_path))
}

fn count_rows(table_dir: &Path) -> usize {
    if !vault_lib::is_real_directory(table_dir) {
        return 0;
    }
    let read = match std::fs::read_dir(table_dir) {
        Ok(r) => r,
        Err(_) => return 0,
    };
    read.flatten()
        .filter(|e| {
            let p = e.path();
            p.extension().and_then(|s| s.to_str()) == Some("md")
                && p.file_name().and_then(|s| s.to_str()) != Some(SCHEMA_FILE)
        })
        .count()
}

/// Default starter table when create is called with no columns/views: one
/// text column "Name" and one default "All" view. Mirrors Notion's "+ New
/// table" so users don't land on an empty grid.
fn default_columns() -> Vec<Column> {
    vec![Column {
        id: format!("col_{}", Ulid::new()),
        name: "Name".to_string(),
        type_: ColumnType::Text,
        options: vec![],
        width: None,
        format: None,
        precision: None,
    }]
}

fn default_views() -> Vec<View> {
    vec![View {
        id: format!("view_{}", Ulid::new()),
        name: "All".to_string(),
        type_: "table".to_string(),
        sorts: vec![],
        filters: parsers::ViewFilters::default(),
        hidden: vec![],
        calculations: BTreeMap::new(),
        group_by: None,
    }]
}

#[tauri::command]
pub fn table_create(
    app: AppHandle,
    state: State<AppState>,
    input: TableCreate,
) -> Result<TableDto, String> {
    let vault = vault_root(&app)?;
    std::fs::create_dir_all(tables_root(&vault)).map_err(|e| e.to_string())?;

    let id = unique_table_id(&vault, &slugify_name(&input.name))?;
    let dir = table_dir(&vault, &id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let table = ParsedTable {
        id: id.clone(),
        name: input.name,
        created: now_iso(),
        favorite: false,
        columns: input.columns.unwrap_or_else(default_columns),
        views: input.views.unwrap_or_else(default_views),
    };
    let path = schema_path(&vault, &id)?;
    write_schema(&state, &path, &table)?;
    Ok(TableDto::from_parsed(table, &vault, &path))
}

#[tauri::command]
pub fn table_get(app: AppHandle, id: String) -> Result<Option<TableDto>, String> {
    let vault = vault_root(&app)?;
    let path = schema_path(&vault, &id)?;
    if !path.exists() {
        return Ok(None);
    }
    read_table(&vault, &path).map(Some)
}

#[tauri::command]
pub fn table_update(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    update: TableUpdate,
) -> Result<TableDto, String> {
    let vault = vault_root(&app)?;
    let path = schema_path(&vault, &id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut table = parsers::parse_table_schema(&content).map_err(|e| format!("{:#}", e))?;

    if let Some(n) = update.name {
        table.name = n;
    }
    if let Some(c) = update.columns {
        table.columns = c;
    }
    if let Some(v) = update.views {
        table.views = v;
    }
    if let Some(f) = update.favorite {
        table.favorite = f;
    }

    write_schema(&state, &path, &table)?;
    Ok(TableDto::from_parsed(table, &vault, &path))
}

#[tauri::command]
pub fn table_delete(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let dir = table_dir(&vault, &id)?;
    if !dir.exists() {
        return Ok(());
    }
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("md")
                && path.file_name().and_then(|s| s.to_str()) != Some(SCHEMA_FILE)
            {
                delete_index_path(&app, &state, &vault, &path);
            }
        }
    }
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        // Walk contents so the watcher can suppress each deletion event.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                watcher.record_self_write(&entry.path());
            }
        }
        watcher.record_self_write(&dir);
    }
    vault_lib::move_to_trash(&vault, &dir)?;
    Ok(())
}

#[tauri::command]
pub async fn tables_all(app: AppHandle) -> Result<Vec<TableMeta>, String> {
    let vault = vault_root(&app)?;
    read_all_tables_meta(&vault)
}

pub(crate) fn read_all_tables_meta(vault: &Path) -> Result<Vec<TableMeta>, String> {
    let dir = tables_root(vault);
    if !vault_lib::is_real_directory(&dir) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        if !vault_lib::is_real_directory(&entry_path) {
            continue;
        }
        let schema = entry_path.join(SCHEMA_FILE);
        if !schema.exists() {
            continue;
        }
        match read_table(vault, &schema) {
            Ok(t) => out.push(TableMeta {
                id: t.id,
                name: t.name,
                created: t.created,
                favorite: t.favorite,
                row_count: count_rows(&entry_path),
            }),
            Err(e) => eprintln!("skipping table {}: {}", entry_path.display(), e),
        }
    }
    out.sort_by_key(|table| table.name.to_lowercase());
    Ok(out)
}

// ---------------------------------------------------------------------------
// Generated tag-table favorites
//
// Custom tables persist `favorite: true` in their _schema.md frontmatter (see
// `TableUpdate`). Generated `#tag` tables are virtual — there's no file to
// flag — so their stars live in a small vault data file at
// `data/database-favorites.json`. Keys are namespaced (`tag:<tag>`) to match
// the database row ids the frontend builds, and so the file can carry other
// database-favorite kinds later without ambiguity.
// ---------------------------------------------------------------------------

fn db_favorites_path(vault: &Path) -> PathBuf {
    vault.join("data").join("database-favorites.json")
}

/// Read the favorite keys (e.g. `tag:task`). Missing or unparseable file →
/// empty list (the file is a derived convenience, never a hard dependency).
fn read_db_favorites(vault: &Path) -> Vec<String> {
    let path = db_favorites_path(vault);
    let Ok(content) = vault_lib::read_record(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&content).unwrap_or_default()
}

/// Namespaced favorite key for a raw tag: strips a leading `#`, trims, and
/// lowercases. "#Task" → "tag:task".
fn tag_favorite_key(tag: &str) -> String {
    format!(
        "tag:{}",
        tag.trim().trim_start_matches('#').to_ascii_lowercase()
    )
}

/// Add or remove a key from the favorites list, returning the sorted,
/// deduped result. Pure so the toggle behavior is unit-testable without a
/// vault or Tauri state.
fn apply_tag_favorite(mut favs: Vec<String>, key: &str, favorite: bool) -> Vec<String> {
    if favorite {
        if !favs.iter().any(|k| k == key) {
            favs.push(key.to_string());
        }
    } else {
        favs.retain(|k| k != key);
    }
    favs.sort();
    favs.dedup();
    favs
}

#[tauri::command]
pub fn database_tag_favorites_get(app: AppHandle) -> Result<Vec<String>, String> {
    let vault = vault_root(&app)?;
    Ok(read_db_favorites(&vault))
}

#[tauri::command]
pub fn database_tag_favorite_set(
    app: AppHandle,
    state: State<AppState>,
    tag: String,
    favorite: bool,
) -> Result<Vec<String>, String> {
    let vault = vault_root(&app)?;
    let key = tag_favorite_key(&tag);
    let favs = apply_tag_favorite(read_db_favorites(&vault), &key, favorite);

    let path = db_favorites_path(&vault);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&favs).map_err(|e| e.to_string())?;
    // Record the self-write so the watcher doesn't surface this as an external
    // change: a `data/` path falls through the frontend's invalidation switch
    // to the coarse "invalidate everything" branch, which shouldn't fire on a
    // star toggle.
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(&path);
    }
    vault_lib::write_atomic(&path, &json).map_err(|e| e.to_string())?;
    Ok(favs)
}

#[tauri::command]
pub fn row_create(
    app: AppHandle,
    state: State<AppState>,
    table_id: String,
    input: RowCreate,
) -> Result<RowDto, String> {
    let vault = vault_root(&app)?;
    let dir = table_dir(&vault, &table_id)?;
    if !dir.exists() {
        return Err(format!("table {} does not exist", table_id));
    }

    let row_id = format!("row_{}", Ulid::new());
    let next_sort_key = read_all_rows(&vault, &table_id)?
        .iter()
        .filter_map(|row| row.sort_key)
        .max_by(f64::total_cmp)
        .unwrap_or(0.0)
        + 1000.0;
    let row = ParsedRow {
        id: row_id.clone(),
        table: table_id.clone(),
        created: now_iso(),
        sort_key: Some(next_sort_key),
        cells: input.cells,
        body: input.body.unwrap_or_default(),
    };
    let path = row_path(&vault, &table_id, &row_id)?;
    write_row(&state, &path, &row)?;
    upsert_row_index(&app, &state, &vault, &path, &row);
    Ok(RowDto::from_parsed(row, &vault, &path))
}

#[tauri::command]
pub fn row_get(app: AppHandle, table_id: String, row_id: String) -> Result<Option<RowDto>, String> {
    let vault = vault_root(&app)?;
    let path = row_path(&vault, &table_id, &row_id)?;
    if !path.exists() {
        return Ok(None);
    }
    read_row(&vault, &path).map(Some)
}

#[tauri::command]
pub fn row_update(
    app: AppHandle,
    state: State<AppState>,
    table_id: String,
    row_id: String,
    update: RowUpdate,
) -> Result<RowDto, String> {
    let vault = vault_root(&app)?;
    let path = row_path(&vault, &table_id, &row_id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut row = parsers::parse_row(&content).map_err(|e| format!("{:#}", e))?;

    if let Some(patch) = update.cells {
        for (col_id, value) in patch {
            if matches!(value, serde_yaml::Value::Null) {
                row.cells.remove(&col_id);
            } else {
                row.cells.insert(col_id, value);
            }
        }
    }
    if let Some(b) = update.body {
        row.body = b;
    }

    write_row(&state, &path, &row)?;
    upsert_row_index(&app, &state, &vault, &path, &row);
    Ok(RowDto::from_parsed(row, &vault, &path))
}

#[tauri::command]
pub fn row_delete(
    app: AppHandle,
    state: State<AppState>,
    table_id: String,
    row_id: String,
) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let path = row_path(&vault, &table_id, &row_id)?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(&path);
    }
    delete_index_path(&app, &state, &vault, &path);
    if path.exists() {
        vault_lib::move_to_trash(&vault, &path)?;
    }
    Ok(())
}

#[tauri::command]
pub fn row_reorder(
    app: AppHandle,
    state: State<AppState>,
    table_id: String,
    input: RowReorder,
) -> Result<Vec<RowDto>, String> {
    let vault = vault_root(&app)?;
    let current = read_all_rows(&vault, &table_id)?;
    validate_row_reorder(&current, &input.row_ids)?;

    let mut rows = Vec::with_capacity(input.row_ids.len());
    for (index, row_id) in input.row_ids.iter().enumerate() {
        let path = row_path(&vault, &table_id, row_id)?;
        let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
        let mut row = parsers::parse_row(&content).map_err(|e| format!("{:#}", e))?;
        row.sort_key = Some((index as f64 + 1.0) * 1000.0);
        write_row(&state, &path, &row)?;
        upsert_row_index(&app, &state, &vault, &path, &row);
        rows.push(RowDto::from_parsed(row, &vault, &path));
    }
    Ok(rows)
}

fn validate_row_reorder(current: &[RowDto], row_ids: &[String]) -> Result<(), String> {
    let expected: BTreeSet<_> = current.iter().map(|row| row.id.as_str()).collect();
    let received: BTreeSet<_> = row_ids.iter().map(String::as_str).collect();
    if row_ids.len() != current.len() || received != expected {
        return Err("row reorder must include each table row exactly once".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn rows_all(app: AppHandle, table_id: String) -> Result<Vec<RowDto>, String> {
    let vault = vault_root(&app)?;
    read_all_rows(&vault, &table_id)
}

pub(crate) fn read_all_rows(vault: &Path, table_id: &str) -> Result<Vec<RowDto>, String> {
    let dir = table_dir(vault, table_id)?;
    if !vault_lib::is_real_directory(&dir) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !vault_lib::is_real_file(&path)
        {
            continue;
        }
        if path.file_name().and_then(|s| s.to_str()) == Some(SCHEMA_FILE) {
            continue;
        }
        match read_row(vault, &path) {
            Ok(r) => out.push(r),
            Err(e) => eprintln!("skipping row {}: {}", path.display(), e),
        }
    }
    // Legacy rows do not have sort_key yet, so keep their creation-time order
    // until a manual reorder assigns keys to the complete table.
    out.sort_by(|a, b| match (a.sort_key, b.sort_key) {
        (Some(a_key), Some(b_key)) => a_key
            .total_cmp(&b_key)
            .then_with(|| a.created.cmp(&b.created)),
        (None, None) => a.created.cmp(&b.created),
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VAULT_SUBDIRS;
    use tempfile::TempDir;

    fn setup_vault() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        for sub in VAULT_SUBDIRS {
            std::fs::create_dir_all(vault.join(sub)).unwrap();
        }
        (tmp, vault)
    }

    fn write_table_schema(vault: &Path, id: &str) -> PathBuf {
        let dir = table_dir(vault, id).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let table = ParsedTable {
            id: id.to_string(),
            name: id.to_string(),
            created: "2026-04-27T10:00:00".to_string(),
            favorite: false,
            columns: vec![Column {
                id: "col_name".to_string(),
                name: "Name".to_string(),
                type_: ColumnType::Text,
                options: vec![],
                width: None,
                format: None,
                precision: None,
            }],
            views: vec![View {
                id: "view_all".to_string(),
                name: "All".to_string(),
                type_: "table".to_string(),
                sorts: vec![],
                filters: parsers::ViewFilters::default(),
                hidden: vec![],
                calculations: BTreeMap::new(),
                group_by: None,
            }],
        };
        let path = schema_path(vault, id).unwrap();
        let serialized = parsers::serialize_table_schema(&table).unwrap();
        std::fs::write(&path, serialized).unwrap();
        path
    }

    fn write_row_file(vault: &Path, table_id: &str, row_id: &str, name: &str) -> PathBuf {
        let mut cells = BTreeMap::new();
        cells.insert(
            "col_name".to_string(),
            serde_yaml::Value::String(name.to_string()),
        );
        let row = ParsedRow {
            id: row_id.to_string(),
            table: table_id.to_string(),
            created: "2026-04-27T10:05:00".to_string(),
            sort_key: None,
            cells,
            body: String::new(),
        };
        let path = row_path(vault, table_id, row_id).unwrap();
        let serialized = parsers::serialize_row(&row).unwrap();
        std::fs::write(&path, serialized).unwrap();
        path
    }

    #[test]
    fn slugify_name_handles_typical_names() {
        assert_eq!(slugify_name("Budget"), "budget");
        assert_eq!(slugify_name("Q3 Goals"), "q3-goals");
        assert_eq!(slugify_name("  Trim  Me  "), "trim-me");
    }

    #[test]
    fn slugify_empty_falls_back() {
        assert_eq!(slugify_name(""), "table");
        assert_eq!(slugify_name("---"), "table");
    }

    #[test]
    fn unique_table_id_appends_2_3_on_collision() {
        let (_tmp, vault) = setup_vault();
        write_table_schema(&vault, "budget");
        assert_eq!(unique_table_id(&vault, "budget").unwrap(), "budget-2");
        write_table_schema(&vault, "budget-2");
        assert_eq!(unique_table_id(&vault, "budget").unwrap(), "budget-3");
    }

    #[test]
    fn count_rows_skips_schema_and_non_md() {
        let (_tmp, vault) = setup_vault();
        write_table_schema(&vault, "budget");
        write_row_file(&vault, "budget", "row_1", "Coffee");
        write_row_file(&vault, "budget", "row_2", "Rent");
        let dir = table_dir(&vault, "budget").unwrap();
        std::fs::write(dir.join("note.txt"), "noise").unwrap();
        assert_eq!(count_rows(&dir), 2);
    }

    #[test]
    fn read_all_tables_meta_sorts_alphabetically() {
        let (_tmp, vault) = setup_vault();
        write_table_schema(&vault, "zebra");
        write_table_schema(&vault, "alpha");
        write_table_schema(&vault, "mike");
        let metas = read_all_tables_meta(&vault).unwrap();
        let names: Vec<_> = metas.iter().map(|m| m.name.clone()).collect();
        assert_eq!(names, vec!["alpha", "mike", "zebra"]);
    }

    #[test]
    fn read_all_tables_meta_ignores_table_dirs_without_schema() {
        let (_tmp, vault) = setup_vault();
        write_table_schema(&vault, "budget");
        std::fs::create_dir_all(tables_root(&vault).join("orphan")).unwrap();
        let metas = read_all_tables_meta(&vault).unwrap();
        assert_eq!(metas.len(), 1);
    }

    #[test]
    fn read_all_rows_skips_schema_file() {
        let (_tmp, vault) = setup_vault();
        write_table_schema(&vault, "budget");
        write_row_file(&vault, "budget", "row_1", "Coffee");
        let rows = read_all_rows(&vault, "budget").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "row_1");
    }

    #[test]
    fn read_all_rows_uses_persisted_manual_order() {
        let (_tmp, vault) = setup_vault();
        write_table_schema(&vault, "budget");
        let first_path = write_row_file(&vault, "budget", "row_first", "First");
        let second_path = write_row_file(&vault, "budget", "row_second", "Second");

        for (path, sort_key) in [(first_path, 2000.0), (second_path, 1000.0)] {
            let content = std::fs::read_to_string(&path).unwrap();
            let mut row = parsers::parse_row(&content).unwrap();
            row.sort_key = Some(sort_key);
            std::fs::write(path, parsers::serialize_row(&row).unwrap()).unwrap();
        }

        let ids: Vec<_> = read_all_rows(&vault, "budget")
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(ids, vec!["row_second", "row_first"]);
    }

    #[test]
    fn row_reorder_requires_an_exact_permutation_of_existing_ids() {
        let current = vec![
            RowDto {
                id: "row_a".to_string(),
                path: String::new(),
                table: "budget".to_string(),
                created: String::new(),
                sort_key: None,
                cells: BTreeMap::new(),
                body: String::new(),
            },
            RowDto {
                id: "row_b".to_string(),
                path: String::new(),
                table: "budget".to_string(),
                created: String::new(),
                sort_key: None,
                cells: BTreeMap::new(),
                body: String::new(),
            },
        ];

        assert!(
            validate_row_reorder(&current, &["row_b".to_string(), "row_a".to_string()]).is_ok()
        );
        assert!(
            validate_row_reorder(&current, &["row_a".to_string(), "row_a".to_string()]).is_err()
        );
        assert!(validate_row_reorder(&current, &["row_a".to_string()]).is_err());
    }

    #[test]
    fn read_all_rows_returns_empty_when_table_missing() {
        let (_tmp, vault) = setup_vault();
        assert!(read_all_rows(&vault, "nonexistent").unwrap().is_empty());
    }

    #[test]
    fn default_columns_and_views_have_unique_ids() {
        let cols = default_columns();
        let views = default_views();
        assert_eq!(cols.len(), 1);
        assert!(cols[0].id.starts_with("col_"));
        assert_eq!(views.len(), 1);
        assert!(views[0].id.starts_with("view_"));
    }

    #[test]
    fn tag_favorite_key_strips_hash_and_lowercases() {
        assert_eq!(tag_favorite_key("#Task"), "tag:task");
        assert_eq!(tag_favorite_key("  event "), "tag:event");
        assert_eq!(tag_favorite_key("YouTube"), "tag:youtube");
    }

    #[test]
    fn apply_tag_favorite_adds_removes_dedups_and_sorts() {
        let favs = apply_tag_favorite(vec![], "tag:task", true);
        assert_eq!(favs, vec!["tag:task"]);
        // Adding the same key again is idempotent.
        let favs = apply_tag_favorite(favs, "tag:task", true);
        assert_eq!(favs, vec!["tag:task"]);
        // A second key sorts deterministically.
        let favs = apply_tag_favorite(favs, "tag:event", true);
        assert_eq!(favs, vec!["tag:event", "tag:task"]);
        // Removing drops just the one key.
        let favs = apply_tag_favorite(favs, "tag:task", false);
        assert_eq!(favs, vec!["tag:event"]);
        // Removing an absent key is a no-op.
        let favs = apply_tag_favorite(favs, "tag:missing", false);
        assert_eq!(favs, vec!["tag:event"]);
    }

    #[test]
    fn read_db_favorites_roundtrips_and_tolerates_missing_or_corrupt() {
        let (_tmp, vault) = setup_vault();
        // Missing file → empty, never an error.
        assert!(read_db_favorites(&vault).is_empty());

        let path = db_favorites_path(&vault);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"["tag:task","tag:event"]"#).unwrap();
        assert_eq!(read_db_favorites(&vault), vec!["tag:task", "tag:event"]);

        // Corrupt JSON degrades to empty rather than panicking.
        std::fs::write(&path, "not json at all").unwrap();
        assert!(read_db_favorites(&vault).is_empty());
    }
}
