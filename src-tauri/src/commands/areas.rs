// Area commands. Areas (formerly "Spaces") describe the workspace
// partition every record can carry as `area: <id>`. Storage:
//
//   areas/<id>.md      ← canonical (file-per-area, since May 2026)
//   data/areas.json    ← legacy index, read-fallback only
//   data/spaces.json   ← legacy-er index, read-fallback only
//
// Reads scan `areas/*.md` first; if that's empty they fall back to the
// JSON files (in priority order). Writes always go to the file-per-area
// store — the boot migration in `vault::migration` materializes the JSON
// list into individual files on first launch after the rename, so the
// JSON fallback is rarely exercised in steady state.

use crate::parsers::{self, Area as ParsedArea};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";
const LEGACY_AREAS_JSON: &str = "data/areas.json";
const LEGACY_SPACES_JSON: &str = "data/spaces.json";

/// DTO returned to the frontend. Mirrors the historical `Area` shape so
/// existing callers don't break; `description` is new in May 2026.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Area {
    pub id: String,
    pub name: String,
    pub color: String,
    /// Freeform markdown the user wrote about the area. Empty on areas
    /// migrated from the JSON store, since the JSON had no body.
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Deserialize)]
struct LegacyAreaEntry {
    id: String,
    name: String,
    color: String,
}

fn default_areas() -> Vec<Area> {
    vec![
        Area {
            id: "woodshed".to_string(),
            name: "Woodshed".to_string(),
            color: "#3F3F46".to_string(),
            description: String::new(),
        },
        Area {
            id: "indie-thinkers".to_string(),
            name: "Indie Thinkers".to_string(),
            color: "#4338CA".to_string(),
            description: String::new(),
        },
        Area {
            id: "tech-twitter".to_string(),
            name: "Tech Twitter".to_string(),
            color: "#1DA1F2".to_string(),
            description: String::new(),
        },
        Area {
            id: "post-in-black".to_string(),
            name: "Post In Black".to_string(),
            color: "#000000".to_string(),
            description: String::new(),
        },
        Area {
            id: "personal".to_string(),
            name: "Personal".to_string(),
            color: "#355E3B".to_string(),
            description: String::new(),
        },
    ]
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

fn area_file_path(vault: &Path, id: &str) -> Result<PathBuf, String> {
    vault_lib::record_file_path(vault, vault_lib::AREAS_DIR, id)
}

pub(crate) fn read_areas(vault: &Path) -> Result<Vec<Area>, String> {
    let dir = vault_lib::areas_dir(vault);
    if vault_lib::is_real_directory(&dir) {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md")
                || !vault_lib::is_real_file(&path)
            {
                continue;
            }
            match read_area_file(&path) {
                Ok(area) => out.push(area),
                Err(e) => eprintln!("skipping {}: {}", path.display(), e),
            }
        }
        if !out.is_empty() {
            // Stable order so the frontend list doesn't shuffle between reads.
            out.sort_by_key(|area| area.name.to_lowercase());
            return Ok(out);
        }
    }
    // Folder missing or empty — try the legacy JSON (areas.json then
    // spaces.json), then defaults. Boot migration normally turns this
    // into files on first launch, so this branch is mostly defensive.
    if let Some(areas) = read_legacy_json(vault, LEGACY_AREAS_JSON)? {
        return Ok(areas);
    }
    if let Some(areas) = read_legacy_json(vault, LEGACY_SPACES_JSON)? {
        return Ok(areas);
    }
    Ok(default_areas())
}

fn read_legacy_json(vault: &Path, rel: &str) -> Result<Option<Vec<Area>>, String> {
    let path = vault.join(rel);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let entries: Vec<LegacyAreaEntry> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some(
        entries
            .into_iter()
            .map(|e| Area {
                id: e.id,
                name: e.name,
                color: e.color,
                description: String::new(),
            })
            .collect(),
    ))
}

fn read_area_file(path: &Path) -> Result<Area, String> {
    let content = vault_lib::read_record(path).map_err(|e| e.to_string())?;
    let parsed = parsers::parse_area(&content).map_err(|e| format!("{:#}", e))?;
    Ok(Area {
        id: parsed.id,
        name: parsed.name,
        color: parsed.color,
        description: parsed.body,
    })
}

fn write_area_file(
    state: &State<AppState>,
    vault: &Path,
    area: &Area,
    created: Option<String>,
) -> Result<(), String> {
    let path = area_file_path(vault, &area.id)?;
    let parsed = ParsedArea {
        id: area.id.clone(),
        name: area.name.clone(),
        color: area.color.clone(),
        created,
        body: area.description.clone(),
    };
    let serialized = parsers::serialize_area(&parsed).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(&path);
    }
    vault_lib::write_atomic(&path, &serialized).map_err(|e| e.to_string())
}

/// Slug a name for use as an area ID. Lowercase, alphanumeric and
/// hyphens only, collapse runs of separators, trim leading/trailing
/// hyphens.
fn slugify(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut last_was_sep = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_was_sep = false;
        } else if !last_was_sep && !out.is_empty() {
            out.push('-');
            last_was_sep = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn unique_slug(base: &str, existing: &[Area]) -> String {
    let mut candidate = base.to_string();
    let mut suffix = 2;
    while existing.iter().any(|s| s.id == candidate) {
        candidate = format!("{}-{}", base, suffix);
        suffix += 1;
    }
    candidate
}

#[tauri::command]
pub async fn areas_get(app: AppHandle) -> Result<Vec<Area>, String> {
    let vault = vault_root(&app)?;
    read_areas(&vault)
}

#[tauri::command]
pub fn area_create(
    app: AppHandle,
    state: State<AppState>,
    name: String,
    color: Option<String>,
) -> Result<Area, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("area name cannot be empty".to_string());
    }
    let vault = vault_root(&app)?;
    let existing = read_areas(&vault)?;

    let base_slug = slugify(&trimmed);
    if base_slug.is_empty() {
        return Err("area name has no usable characters".to_string());
    }
    let id = unique_slug(&base_slug, &existing);
    let area = Area {
        id,
        name: trimmed,
        color: color.unwrap_or_default(),
        description: String::new(),
    };
    let now = chrono::Local::now().to_rfc3339();
    write_area_file(&state, &vault, &area, Some(now))?;
    Ok(area)
}

#[derive(Debug, Default, Deserialize)]
pub struct AreaUpdate {
    pub name: Option<String>,
    pub color: Option<String>,
    pub description: Option<String>,
}

#[tauri::command]
pub fn area_update(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    update: AreaUpdate,
) -> Result<Area, String> {
    let vault = vault_root(&app)?;
    let path = area_file_path(&vault, &id)?;

    // Preserve `created` from the existing file if it had one.
    let mut existing_created: Option<String> = None;
    let mut current = if path.is_file() {
        let raw = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
        let parsed = parsers::parse_area(&raw).map_err(|e| format!("{:#}", e))?;
        existing_created = parsed.created.clone();
        Area {
            id: parsed.id,
            name: parsed.name,
            color: parsed.color,
            description: parsed.body,
        }
    } else {
        // The file might not exist yet on a vault where the boot
        // migration hasn't run. Look up the area by id in the read path
        // (which falls through to the legacy JSON), then write a fresh
        // file. Treat a missing area as a hard error.
        read_areas(&vault)?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| format!("area '{}' not found", id))?
    };

    if let Some(n) = update.name {
        let trimmed = n.trim().to_string();
        if trimmed.is_empty() {
            return Err("area name cannot be empty".to_string());
        }
        current.name = trimmed;
    }
    if let Some(c) = update.color {
        current.color = c;
    }
    if let Some(d) = update.description {
        current.description = d;
    }

    write_area_file(&state, &vault, &current, existing_created)?;
    Ok(current)
}

#[tauri::command]
pub fn area_delete(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let path = area_file_path(&vault, &id)?;
    if path.is_file() {
        if let Some(watcher) = state.watcher.lock_recover().as_ref() {
            watcher.record_self_write(&path);
        }
        vault_lib::move_to_trash(&vault, &path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_vault() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::create_dir_all(vault.join("areas")).unwrap();
        std::fs::create_dir_all(vault.join("data")).unwrap();
        (tmp, vault)
    }

    fn write_area_directly(vault: &Path, area: &Area, created: Option<&str>) {
        let parsed = ParsedArea {
            id: area.id.clone(),
            name: area.name.clone(),
            color: area.color.clone(),
            created: created.map(String::from),
            body: area.description.clone(),
        };
        let serialized = parsers::serialize_area(&parsed).unwrap();
        std::fs::write(area_file_path(vault, &area.id).unwrap(), serialized).unwrap();
    }

    #[test]
    fn read_areas_scans_files_alphabetically_by_name() {
        let (_tmp, vault) = setup_vault();
        write_area_directly(
            &vault,
            &Area {
                id: "z".to_string(),
                name: "Zoo".to_string(),
                color: "#000".to_string(),
                description: String::new(),
            },
            None,
        );
        write_area_directly(
            &vault,
            &Area {
                id: "a".to_string(),
                name: "Aardvark".to_string(),
                color: "#000".to_string(),
                description: String::new(),
            },
            None,
        );
        let out = read_areas(&vault).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "a");
        assert_eq!(out[1].id, "z");
    }

    #[test]
    fn read_areas_skips_non_md_files() {
        let (_tmp, vault) = setup_vault();
        write_area_directly(
            &vault,
            &Area {
                id: "x".to_string(),
                name: "X".to_string(),
                color: "#000".to_string(),
                description: String::new(),
            },
            None,
        );
        std::fs::write(vault.join("areas").join("not-an-area.txt"), "noise").unwrap();
        assert_eq!(read_areas(&vault).unwrap().len(), 1);
    }

    #[test]
    fn read_areas_falls_back_to_areas_json_when_folder_empty() {
        let (_tmp, vault) = setup_vault();
        std::fs::write(
            vault.join("data/areas.json"),
            r##"[{"id":"x","name":"X","color":"#abc"}]"##,
        )
        .unwrap();
        let out = read_areas(&vault).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "x");
        assert_eq!(out[0].description, "");
    }

    #[test]
    fn read_areas_falls_back_to_spaces_json_when_no_areas_json() {
        let (_tmp, vault) = setup_vault();
        std::fs::write(
            vault.join("data/spaces.json"),
            r##"[{"id":"y","name":"Y","color":"#def"}]"##,
        )
        .unwrap();
        let out = read_areas(&vault).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "y");
    }

    #[test]
    fn read_areas_returns_defaults_when_nothing_exists() {
        let (_tmp, vault) = setup_vault();
        let out = read_areas(&vault).unwrap();
        assert!(out.iter().any(|a| a.id == "personal"));
    }

    #[test]
    fn slugify_handles_typical_names() {
        assert_eq!(slugify("Indie Thinkers"), "indie-thinkers");
        assert_eq!(slugify("Tech Twitter"), "tech-twitter");
        assert_eq!(slugify("Post In Black"), "post-in-black");
        assert_eq!(slugify("Personal"), "personal");
        assert_eq!(slugify("Side  Project!"), "side-project");
        assert_eq!(slugify("---Trim me---"), "trim-me");
    }

    #[test]
    fn slugify_strips_non_alphanumeric_runs() {
        assert_eq!(slugify("Q3 Roadmap (2026)"), "q3-roadmap-2026");
        assert_eq!(slugify("AI / ML"), "ai-ml");
    }

    #[test]
    fn unique_slug_appends_suffix_on_collision() {
        let existing = vec![
            Area {
                id: "personal".to_string(),
                name: "Personal".to_string(),
                color: "#000".to_string(),
                description: String::new(),
            },
            Area {
                id: "personal-2".to_string(),
                name: "Personal".to_string(),
                color: "#000".to_string(),
                description: String::new(),
            },
        ];
        assert_eq!(unique_slug("personal", &existing), "personal-3");
        assert_eq!(unique_slug("work", &existing), "work");
    }

    #[test]
    fn default_areas_has_five() {
        assert_eq!(default_areas().len(), 5);
        assert!(default_areas().iter().any(|s| s.id == "personal"));
    }
}
