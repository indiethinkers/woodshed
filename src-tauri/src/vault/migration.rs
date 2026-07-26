// One-shot boot migration for the May 2026 surface rename:
//   calendar/        → cadence/
//   data/spaces.json → data/areas.json
//   data/areas.json  → areas/<id>.md         (file-per-area scaffold)
//
// Idempotent: only moves files when the legacy folder/file exists AND the
// new destination is empty (or absent). Skips iCloud-synced vaults — rename
// across the iCloud sync boundary is not reliable, so those vaults stay on
// the legacy paths and the read-fallback in vault::cadence_dir keeps things
// working.
//
// Old folders are left in place (empty) after the migration. Users can
// `rmdir` them if they want; we don't delete user-touched dirs ourselves.

use super::{
    ensure_vault_directory, is_icloud_path, move_to_trash, record_file_path, validate_daily_date,
    write_atomic, AREAS_DIR, CADENCE_DIR, EVENTS_DIR, LEGACY_CALENDAR_DIR, LEGACY_DAILY_DIR,
    RESOURCES_DIR,
};
use crate::parsers::{self, Area as ParsedArea, DailyJournal};
use anyhow::{Context, Result};
use chrono::NaiveDate;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct MigrationReport {
    pub cadence_files_moved: usize,
    /// Resource files whose frontmatter type was normalized to `resource`.
    pub resource_files_normalized: usize,
    pub spaces_json_migrated: bool,
    pub area_files_created: usize,
    /// Daily files moved from `daily/` to `cadence/`.
    pub daily_files_moved: usize,
    /// Legacy `cadence/<slug>-<date>.md` event files that were parsed,
    /// inlined into their day's `cadence/<date>.md` frontmatter, and
    /// then moved to recoverable internal trash.
    pub event_files_inlined: usize,
    /// Events lifted out of inline `cadence/<date>.md` frontmatter into
    /// per-file records at `events/<id>.md`. The daily file's `events:`
    /// frontmatter array is cleared after the lift so the daily's body
    /// stays the only thing the user edits on that surface.
    pub events_lifted_to_files: usize,
    pub skipped_icloud: bool,
}

pub fn migrate_legacy_folders(vault: &Path) -> Result<MigrationReport> {
    let mut report = MigrationReport::default();
    if is_icloud_path(vault) {
        report.skipped_icloud = true;
        return Ok(report);
    }
    report.cadence_files_moved = move_directory_contents(vault, LEGACY_CALENDAR_DIR, CADENCE_DIR)?;
    report.spaces_json_migrated = migrate_spaces_json(vault)?;
    report.area_files_created = scaffold_area_files_from_json(vault)?;
    report.resource_files_normalized = normalize_resource_file_types(vault)?;
    report.daily_files_moved = move_daily_into_cadence(vault)?;
    // Two-step convergence on the new per-file events layout:
    //   1) inline_legacy_event_files: very-old `cadence/<slug>-<date>.md`
    //      files get folded into their day's daily frontmatter.
    //   2) lift_inline_events_to_files: inline frontmatter events lifted
    //      out into per-file `events/<id>.md` records.
    // After (1) every event is inline; after (2) every event is in events/.
    report.event_files_inlined = inline_legacy_event_files(vault)?;
    report.events_lifted_to_files = lift_inline_events_to_files(vault)?;
    Ok(report)
}

/// Move every file from `vault/<from>/` into `vault/<to>/` if `from` exists,
/// has at least one entry, and `to` is absent or empty. Returns the number
/// of files moved.
fn move_directory_contents(vault: &Path, from: &str, to: &str) -> Result<usize> {
    let from_dir = vault.join(from);
    let to_dir = vault.join(to);

    if !from_dir.is_dir() {
        return Ok(0);
    }
    let from_entries: Vec<_> = std::fs::read_dir(&from_dir)
        .with_context(|| format!("read legacy dir {}", from_dir.display()))?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| format!("collect legacy dir {}", from_dir.display()))?;
    if from_entries.is_empty() {
        return Ok(0);
    }

    // Refuse to clobber an already-populated new dir. If both are populated
    // the user has done something manual; leave them alone and let read
    // fallbacks handle it.
    if to_dir.is_dir() {
        let to_count = std::fs::read_dir(&to_dir)
            .with_context(|| format!("read new dir {}", to_dir.display()))?
            .count();
        if to_count > 0 {
            return Ok(0);
        }
    } else {
        std::fs::create_dir_all(&to_dir)
            .with_context(|| format!("create new dir {}", to_dir.display()))?;
    }

    let mut moved = 0;
    for entry in from_entries {
        let src = entry.path();
        let name = entry.file_name();
        let dst = to_dir.join(&name);
        std::fs::rename(&src, &dst)
            .with_context(|| format!("move {} → {}", src.display(), dst.display()))?;
        moved += 1;
    }
    Ok(moved)
}

/// Migrate `data/spaces.json` to `data/areas.json` if and only if the new
/// file doesn't exist yet. Leaves the old file in place — `commands/areas`
/// already reads it as a fallback for older Woodshed builds.
fn migrate_spaces_json(vault: &Path) -> Result<bool> {
    let legacy = vault.join("data").join("spaces.json");
    let new = vault.join("data").join("areas.json");
    if !legacy.is_file() || new.is_file() {
        return Ok(false);
    }
    std::fs::create_dir_all(vault.join("data"))
        .with_context(|| "ensure data/ dir for areas.json migration")?;
    std::fs::copy(&legacy, &new)
        .with_context(|| format!("copy {} → {}", legacy.display(), new.display()))?;
    Ok(true)
}

#[derive(Debug, Deserialize)]
struct AreaJsonEntry {
    id: String,
    name: String,
    color: String,
}

/// Scaffold one `areas/<id>.md` file per entry in `data/areas.json` (or
/// `data/spaces.json`) when the `areas/` folder exists but is empty. Run
/// after `migrate_spaces_json` so we always read from the most recent
/// JSON. Empty body — the user fills in descriptions later.
fn scaffold_area_files_from_json(vault: &Path) -> Result<usize> {
    let dir = vault.join(AREAS_DIR);
    if !dir.is_dir() {
        // Not yet scaffolded by ensure_dirs — caller will create on next boot.
        return Ok(0);
    }
    // Refuse to scaffold if any files are already there.
    let existing = std::fs::read_dir(&dir)
        .with_context(|| format!("read {}", dir.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
        .count();
    if existing > 0 {
        return Ok(0);
    }

    // Prefer the canonical name; fall back to the legacy.
    let json_path = {
        let canonical = vault.join("data").join("areas.json");
        let legacy = vault.join("data").join("spaces.json");
        if canonical.is_file() {
            canonical
        } else if legacy.is_file() {
            legacy
        } else {
            return Ok(0);
        }
    };

    let raw = crate::vault::read_record(&json_path)
        .with_context(|| format!("read {}", json_path.display()))?;
    let entries: Vec<AreaJsonEntry> =
        serde_json::from_str(&raw).with_context(|| format!("parse {}", json_path.display()))?;

    let mut created = 0;
    for entry in entries {
        let parsed = ParsedArea {
            id: entry.id.clone(),
            name: entry.name,
            color: entry.color,
            // No created timestamp — these came from JSON, which never had one.
            created: None,
            body: String::new(),
        };
        let serialized = parsers::serialize_area(&parsed)
            .with_context(|| format!("serialize area {}", entry.id))?;
        let dst = record_file_path(vault, AREAS_DIR, &entry.id).map_err(anyhow::Error::msg)?;
        write_atomic(&dst, &serialized).with_context(|| format!("write {}", dst.display()))?;
        created += 1;
    }
    Ok(created)
}

fn normalize_resource_file_types(vault: &Path) -> Result<usize> {
    let dir = vault.join(RESOURCES_DIR);
    if !dir.is_dir() {
        return Ok(0);
    }

    let mut normalized = 0;
    for entry in std::fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry.with_context(|| format!("entry in {}", dir.display()))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }

        let raw = match crate::vault::read_record(&path) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let Some((frontmatter, body)) = split_frontmatter(&raw) else {
            continue;
        };
        let mut map: serde_yaml::Mapping = match serde_yaml::from_str(frontmatter) {
            Ok(map) => map,
            Err(_) => continue,
        };

        let type_key = serde_yaml::Value::String("type".to_string());
        if map.get(&type_key).and_then(serde_yaml::Value::as_str) == Some("resource") {
            continue;
        }
        if !resource_shaped_frontmatter(&map) {
            continue;
        }

        map.insert(type_key, serde_yaml::Value::String("resource".to_string()));
        let serialized =
            serde_yaml::to_string(&map).with_context(|| format!("serialize {}", path.display()))?;
        let next = format!("---\n{}---{}", serialized, body);
        super::write_atomic(&path, &next).with_context(|| format!("write {}", path.display()))?;
        normalized += 1;
    }

    Ok(normalized)
}

fn split_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let rest = raw.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let frontmatter = &rest[..end];
    let body = &rest[end + "\n---".len()..];
    Some((frontmatter, body))
}

fn resource_shaped_frontmatter(map: &serde_yaml::Mapping) -> bool {
    ["id", "title", "url", "source", "saved"].iter().all(|key| {
        map.get(serde_yaml::Value::String((*key).to_string()))
            .is_some()
    })
}

/// Move `daily/YYYY-MM-DD.md` files into `cadence/`. Daily journals
/// and events now share the same folder so the user can browse a single
/// `cadence/` directory in their vault. Skips any destination that
/// already exists (defensive — though `cadence/` wouldn't have date-
/// shaped filenames before this migration).
fn move_daily_into_cadence(vault: &Path) -> Result<usize> {
    let daily = vault.join(LEGACY_DAILY_DIR);
    let cadence = vault.join(CADENCE_DIR);
    if !daily.is_dir() {
        return Ok(0);
    }
    std::fs::create_dir_all(&cadence).with_context(|| format!("create {}", cadence.display()))?;
    let mut moved = 0;
    for entry in std::fs::read_dir(&daily).with_context(|| format!("read {}", daily.display()))? {
        let entry = entry.with_context(|| format!("entry in {}", daily.display()))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let filename = match path.file_name() {
            Some(n) => n.to_os_string(),
            None => continue,
        };
        let dst = cadence.join(&filename);
        if dst.exists() {
            // Destination already populated. Leave the legacy file in
            // place; running again is safe.
            continue;
        }
        std::fs::rename(&path, &dst)
            .with_context(|| format!("move {} → {}", path.display(), dst.display()))?;
        moved += 1;
    }
    Ok(moved)
}

/// Inline every legacy `cadence/<slug>-<date>.md` event file into its
/// day's `cadence/<date>.md` daily file. Events for a day that has no
/// daily file get one scaffolded with an empty body. After inlining,
/// the legacy event file is deleted.
///
/// Skips:
///   - `cadence/<date>.md` daily files (already inline)
///   - `cadence/gcal-*.md` legacy iCal cache files (handled elsewhere)
///   - any file whose frontmatter can't parse as `type: event` (e.g.
///     a note that happened to land here)
fn inline_legacy_event_files(vault: &Path) -> Result<usize> {
    let cadence = vault.join(CADENCE_DIR);
    if !cadence.is_dir() {
        return Ok(0);
    }
    let mut inlined = 0;
    let entries: Vec<_> = std::fs::read_dir(&cadence)
        .with_context(|| format!("read {}", cadence.display()))?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| format!("collect {}", cadence.display()))?;
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Skip daily files and the cache leftovers.
        if NaiveDate::parse_from_str(&stem, "%Y-%m-%d").is_ok() {
            continue;
        }
        if stem.starts_with("gcal-") {
            continue;
        }
        // Try to parse as an event. Anything that doesn't parse is
        // either pre-existing user content or corrupted — leave alone.
        let content = match crate::vault::read_record(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let event = match parsers::parse_event(&content) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let target_date = event
            .date
            .split('T')
            .next()
            .unwrap_or(&event.date)
            .to_string();
        if validate_daily_date(&target_date).is_err() {
            // Event has a malformed date. Don't risk inlining into the
            // wrong daily — skip it.
            continue;
        }
        let daily_path =
            record_file_path(vault, CADENCE_DIR, &target_date).map_err(anyhow::Error::msg)?;
        let mut daily = if daily_path.is_file() {
            let raw = crate::vault::read_record(&daily_path)
                .with_context(|| format!("read {}", daily_path.display()))?;
            parsers::parse_daily(&raw).unwrap_or(DailyJournal {
                date: target_date.clone(),
                events: vec![],
                body: String::new(),
            })
        } else {
            DailyJournal {
                date: target_date.clone(),
                events: vec![],
                body: String::new(),
            }
        };
        // De-dup: if the event id is already inline, skip the inlining
        // step but still delete the duplicate standalone file.
        let already = daily.events.iter().any(|e| e.id == event.id);
        if !already {
            daily.events.push(event);
        }
        let serialized = parsers::serialize_daily(&daily)
            .with_context(|| format!("serialize daily {target_date}"))?;
        // Write the daily atomically *before* deleting the source file
        // so we never lose the event if the rename fails mid-flight.
        write_atomic(&daily_path, &serialized)
            .with_context(|| format!("write {}", daily_path.display()))?;
        move_to_trash(vault, &path)
            .map_err(anyhow::Error::msg)
            .with_context(|| format!("trash migrated source {}", path.display()))?;
        inlined += 1;
    }
    Ok(inlined)
}

/// Lift every inline event out of `cadence/<date>.md` frontmatter into a
/// standalone `events/<id>.md` record. Each event gets its own markdown
/// file with the same metadata + an empty body the user can fill with
/// meeting notes. The daily file's `events:` array is cleared so future
/// reads of the daily file return just its body.
///
/// Idempotent: a daily with no inline events is skipped; an event id
/// already present at `events/<id>.md` is not re-written (data
/// preserved). Skips iCloud vaults — same rationale as the surface-
/// rename migrations.
fn lift_inline_events_to_files(vault: &Path) -> Result<usize> {
    let cadence = vault.join(CADENCE_DIR);
    if !cadence.is_dir() {
        return Ok(0);
    }
    ensure_vault_directory(vault, &[EVENTS_DIR]).map_err(anyhow::Error::msg)?;

    let mut lifted = 0;
    let entries: Vec<_> = std::fs::read_dir(&cadence)
        .with_context(|| format!("read {}", cadence.display()))?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| format!("collect {}", cadence.display()))?;

    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Only daily files (cadence/YYYY-MM-DD.md) carry inline events.
        if NaiveDate::parse_from_str(&stem, "%Y-%m-%d").is_err() {
            continue;
        }
        let raw =
            crate::vault::read_record(&path).with_context(|| format!("read {}", path.display()))?;
        let mut daily = match parsers::parse_daily(&raw) {
            Ok(d) => d,
            // Don't touch a daily we can't parse. Migration should never
            // be a destructive force on user content.
            Err(_) => continue,
        };
        if daily.events.is_empty() {
            continue;
        }
        // Write each inline event out to its own file. Pre-existing files
        // at `events/<id>.md` win — we never overwrite, because the file
        // version is the new canonical home and may already carry edits.
        for event in daily.events.drain(..) {
            let dst = record_file_path(vault, EVENTS_DIR, &event.id).map_err(anyhow::Error::msg)?;
            if dst.exists() {
                continue;
            }
            let serialized = parsers::serialize_event(&event)
                .with_context(|| format!("serialize event {}", event.id))?;
            write_atomic(&dst, &serialized).with_context(|| format!("write {}", dst.display()))?;
            lifted += 1;
        }
        // Re-serialize the daily without its events. The `events:` key
        // disappears from the YAML (skip_serializing_if Vec::is_empty),
        // leaving just `type: daily` + `date:` and the journal body.
        let serialized = parsers::serialize_daily(&daily)
            .with_context(|| format!("serialize daily {}", daily.date))?;
        write_atomic(&path, &serialized).with_context(|| format!("write {}", path.display()))?;
    }
    Ok(lifted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn touch(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn moves_calendar_to_cadence() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(&vault.join("calendar/event-a.md"), "a");
        touch(&vault.join("calendar/event-b.md"), "b");

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.cadence_files_moved, 2);
        assert!(vault.join("cadence/event-a.md").is_file());
        assert!(vault.join("cadence/event-b.md").is_file());
        assert!(!vault.join("calendar/event-a.md").exists());
        // Old folder stays around (empty)
        assert!(vault.join("calendar").is_dir());
    }

    #[test]
    fn normalizes_resource_frontmatter_type() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(
            &vault.join("resources/link-a.md"),
            "---\ntype: clipping\nid: link-a\ntitle: Link A\nurl: https://example.com\nsource: example.com\nsaved: 2026-05-16T10:00:00\n---\n\nbody",
        );

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.resource_files_normalized, 1);
        let raw = std::fs::read_to_string(vault.join("resources/link-a.md")).unwrap();
        assert!(raw.contains("type: resource"));
    }

    #[test]
    fn migrates_spaces_json_to_areas_json() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(
            &vault.join("data/spaces.json"),
            r##"[{"id":"x","name":"X","color":"#000"}]"##,
        );

        let report = migrate_legacy_folders(&vault).unwrap();
        assert!(report.spaces_json_migrated);
        assert!(vault.join("data/areas.json").is_file());
        assert!(vault.join("data/spaces.json").is_file()); // Legacy left in place
        assert_eq!(
            std::fs::read_to_string(vault.join("data/areas.json")).unwrap(),
            r##"[{"id":"x","name":"X","color":"#000"}]"##
        );
    }

    #[test]
    fn idempotent_when_new_dir_already_populated() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(&vault.join("calendar/legacy.md"), "legacy");
        touch(&vault.join("cadence/already-here.md"), "new");

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.cadence_files_moved, 0);
        // Legacy file untouched
        assert!(vault.join("calendar/legacy.md").is_file());
        assert!(vault.join("cadence/already-here.md").is_file());
    }

    #[test]
    fn idempotent_when_legacy_empty() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::create_dir_all(vault.join("calendar")).unwrap();

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.cadence_files_moved, 0);
    }

    #[test]
    fn idempotent_when_run_twice() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(&vault.join("calendar/a.md"), "a");
        touch(&vault.join("data/spaces.json"), "[]");

        let first = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(first.cadence_files_moved, 1);
        assert_eq!(first.resource_files_normalized, 0);
        assert!(first.spaces_json_migrated);

        let second = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(second.cadence_files_moved, 0);
        assert_eq!(second.resource_files_normalized, 0);
        assert!(!second.spaces_json_migrated);
    }

    #[test]
    fn skips_icloud_paths() {
        let icloud = Path::new("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/woodshed");
        let report = migrate_legacy_folders(icloud).unwrap();
        assert!(report.skipped_icloud);
        assert_eq!(report.cadence_files_moved, 0);
    }

    #[test]
    fn does_nothing_when_no_legacy_folders_exist() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::create_dir_all(vault.join("cadence")).unwrap();

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report, MigrationReport::default());
    }

    #[test]
    fn scaffolds_area_files_from_areas_json() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::create_dir_all(vault.join("areas")).unwrap();
        touch(
            &vault.join("data/areas.json"),
            r##"[{"id":"woodshed","name":"Woodshed","color":"#378ADD"},{"id":"personal","name":"Personal","color":"#888780"}]"##,
        );

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.area_files_created, 2);
        assert!(vault.join("areas/woodshed.md").is_file());
        assert!(vault.join("areas/personal.md").is_file());

        let raw = std::fs::read_to_string(vault.join("areas/woodshed.md")).unwrap();
        assert!(raw.contains("type: area"));
        assert!(raw.contains("name: Woodshed"));
    }

    #[test]
    fn scaffolds_area_files_from_legacy_spaces_json_after_json_rename() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::create_dir_all(vault.join("areas")).unwrap();
        touch(
            &vault.join("data/spaces.json"),
            r##"[{"id":"x","name":"X","color":"#abc"}]"##,
        );
        // No areas.json — migrate_spaces_json will create it first; then
        // scaffold_area_files_from_json reads the freshly-created areas.json.

        let report = migrate_legacy_folders(&vault).unwrap();
        assert!(report.spaces_json_migrated);
        assert_eq!(report.area_files_created, 1);
        assert!(vault.join("areas/x.md").is_file());
    }

    #[test]
    fn scaffold_skips_when_areas_folder_already_has_files() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(
            &vault.join("areas/existing.md"),
            "---\ntype: area\nid: existing\nname: Existing\ncolor: \"#000\"\n---\n",
        );
        touch(
            &vault.join("data/areas.json"),
            r##"[{"id":"x","name":"X","color":"#abc"}]"##,
        );

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.area_files_created, 0);
        assert!(!vault.join("areas/x.md").exists());
    }

    #[test]
    fn scaffold_skips_when_areas_folder_missing() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        // No areas/ folder. ensure_dirs would create it; migration shouldn't.
        touch(
            &vault.join("data/areas.json"),
            r##"[{"id":"x","name":"X","color":"#abc"}]"##,
        );
        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.area_files_created, 0);
    }

    #[test]
    fn moves_daily_into_cadence() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(
            &vault.join("daily/2026-04-25.md"),
            "---\ntype: daily\ndate: 2026-04-25\n---\n\nNotes for the day.",
        );
        touch(
            &vault.join("daily/2026-04-26.md"),
            "---\ntype: daily\ndate: 2026-04-26\n---\n",
        );

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.daily_files_moved, 2);
        assert!(vault.join("cadence/2026-04-25.md").is_file());
        assert!(vault.join("cadence/2026-04-26.md").is_file());
        assert!(!vault.join("daily/2026-04-25.md").exists());
        // Daily file's body must survive the move byte-identical.
        let moved = std::fs::read_to_string(vault.join("cadence/2026-04-25.md")).unwrap();
        assert!(moved.contains("Notes for the day."));
    }

    #[test]
    fn inlines_legacy_event_files_into_daily_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        // Legacy daily plus two legacy event files that anchor on the same date.
        touch(
            &vault.join("daily/2026-04-25.md"),
            "---\ntype: daily\ndate: 2026-04-25\n---\n\nMorning notes.",
        );
        touch(
            &vault.join("cadence/standup-2026-04-25.md"),
            "---\ntype: event\nid: e_standup\ntitle: Standup\ndate: 2026-04-25T09:00:00-04:00\nduration: 15\narea: woodshed\n---\n",
        );
        touch(
            &vault.join("cadence/alex-1-1-2026-04-25.md"),
            "---\ntype: event\nid: e_alex\ntitle: \"Alex 1:1\"\ndate: 2026-04-25T11:00:00-04:00\nduration: 30\narea: acme\n---\n\nAgenda: Q3 roadmap",
        );

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.daily_files_moved, 1);
        assert_eq!(report.event_files_inlined, 2);
        // The same pass also lifts the freshly-inlined events out to
        // events/<id>.md.
        assert_eq!(report.events_lifted_to_files, 2);

        // Legacy event files removed.
        assert!(!vault.join("cadence/standup-2026-04-25.md").exists());
        assert!(!vault.join("cadence/alex-1-1-2026-04-25.md").exists());

        // The daily file in cadence/ keeps its body but no longer carries
        // inline events — they live in events/ now.
        let daily_raw = std::fs::read_to_string(vault.join("cadence/2026-04-25.md")).unwrap();
        let daily = crate::parsers::parse_daily(&daily_raw).unwrap();
        assert!(daily.events.is_empty());
        assert!(daily.body.contains("Morning notes."));

        // The two events are at events/<id>.md.
        assert!(vault.join("events/e_standup.md").is_file());
        assert!(vault.join("events/e_alex.md").is_file());
        let standup = crate::parsers::parse_event(
            &std::fs::read_to_string(vault.join("events/e_standup.md")).unwrap(),
        )
        .unwrap();
        assert_eq!(standup.title, "Standup");
        let alex = crate::parsers::parse_event(
            &std::fs::read_to_string(vault.join("events/e_alex.md")).unwrap(),
        )
        .unwrap();
        assert_eq!(alex.title, "Alex 1:1");
    }

    #[test]
    fn inline_scaffolds_daily_when_missing() {
        // Legacy event file with no matching daily file: migration
        // creates a daily for the date AND lifts the event back out
        // to events/<id>.md in the same pass.
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(
            &vault.join("cadence/lunch-2026-05-01.md"),
            "---\ntype: event\nid: e_lunch\ntitle: Lunch\ndate: 2026-05-01T12:00:00-04:00\nduration: 60\narea: personal\n---\n",
        );

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.event_files_inlined, 1);
        assert_eq!(report.events_lifted_to_files, 1);
        // Daily file was scaffolded; now empty after the lift.
        assert!(vault.join("cadence/2026-05-01.md").is_file());
        let daily = crate::parsers::parse_daily(
            &std::fs::read_to_string(vault.join("cadence/2026-05-01.md")).unwrap(),
        )
        .unwrap();
        assert!(daily.events.is_empty());
        // The event lives at events/<id>.md.
        assert!(vault.join("events/e_lunch.md").is_file());
    }

    #[test]
    fn inline_skips_gcal_cache_files() {
        // gcal-*.md files are leftovers from the pre-cache iCal sync.
        // They aren't real vault events and shouldn't be inlined.
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(&vault.join("cadence/gcal-abc123def456.md"), "---\ntype: event\nid: gcal-trash\ntitle: x\ndate: 2026-05-01T08:00:00-04:00\nduration: 30\narea: x\n---\n");
        touch(&vault.join("cadence/standup-2026-05-01.md"), "---\ntype: event\nid: e_standup\ntitle: Standup\ndate: 2026-05-01T09:00:00-04:00\nduration: 15\narea: woodshed\n---\n");

        let report = migrate_legacy_folders(&vault).unwrap();
        // Only the standup got inlined.
        assert_eq!(report.event_files_inlined, 1);
        // The gcal-* file is untouched here — the boot-time cleanup
        // sweep (separate from the migration) handles it.
        assert!(vault.join("cadence/gcal-abc123def456.md").exists());
    }

    #[test]
    fn migration_is_idempotent_after_inlining() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(
            &vault.join("daily/2026-04-25.md"),
            "---\ntype: daily\ndate: 2026-04-25\n---\n",
        );
        touch(
            &vault.join("cadence/standup-2026-04-25.md"),
            "---\ntype: event\nid: e_standup\ntitle: Standup\ndate: 2026-04-25T09:00:00-04:00\nduration: 15\narea: woodshed\n---\n",
        );

        let first = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(first.daily_files_moved, 1);
        assert_eq!(first.event_files_inlined, 1);
        // The freshly-inlined event lands in events/ in the same pass.
        assert_eq!(first.events_lifted_to_files, 1);

        // Second pass: nothing left to move/inline/lift.
        let second = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(second.daily_files_moved, 0);
        assert_eq!(second.event_files_inlined, 0);
        assert_eq!(second.events_lifted_to_files, 0);
    }

    #[test]
    fn lifts_inline_events_into_events_dir() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        // Daily file with two inline events and a journal body.
        touch(
            &vault.join("cadence/2026-05-11.md"),
            "---\ntype: daily\ndate: 2026-05-11\nevents:\n- id: e_001\n  title: Standup\n  date: 2026-05-11T09:00:00-04:00\n  duration: 15\n  area: woodshed\n- id: e_002\n  title: Alex 1:1\n  date: 2026-05-11T11:00:00-04:00\n  duration: 30\n  area: acme\n---\n\nMorning notes.",
        );

        let report = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(report.events_lifted_to_files, 2);

        // Both events are now standalone files.
        assert!(vault.join("events/e_001.md").is_file());
        assert!(vault.join("events/e_002.md").is_file());

        // The daily file no longer carries inline events but keeps its body.
        let daily = crate::parsers::parse_daily(
            &std::fs::read_to_string(vault.join("cadence/2026-05-11.md")).unwrap(),
        )
        .unwrap();
        assert!(daily.events.is_empty());
        assert!(daily.body.contains("Morning notes."));

        // Standalone event file parses back to the right shape.
        let event = crate::parsers::parse_event(
            &std::fs::read_to_string(vault.join("events/e_001.md")).unwrap(),
        )
        .unwrap();
        assert_eq!(event.id, "e_001");
        assert_eq!(event.title, "Standup");
    }

    #[test]
    fn lift_preserves_existing_events_file() {
        // If the user already edited events/<id>.md (e.g. added meeting
        // notes), the lift step must not clobber the file body.
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(
            &vault.join("cadence/2026-05-11.md"),
            "---\ntype: daily\ndate: 2026-05-11\nevents:\n- id: e_001\n  title: Standup\n  date: 2026-05-11T09:00:00-04:00\n  duration: 15\n  area: woodshed\n---\n",
        );
        touch(
            &vault.join("events/e_001.md"),
            "---\ntype: event\nid: e_001\ntitle: Standup (renamed)\ndate: 2026-05-11T09:00:00-04:00\nduration: 15\narea: woodshed\nattendees: []\nrecurring: none\n---\n\nMy meeting notes.",
        );

        let report = migrate_legacy_folders(&vault).unwrap();
        // Pre-existing file: not counted as lifted (we didn't write it).
        assert_eq!(report.events_lifted_to_files, 0);

        // The file still has the user's notes intact.
        let raw = std::fs::read_to_string(vault.join("events/e_001.md")).unwrap();
        assert!(raw.contains("My meeting notes."));
        assert!(raw.contains("Standup (renamed)"));

        // The daily still got its inline events cleared.
        let daily = crate::parsers::parse_daily(
            &std::fs::read_to_string(vault.join("cadence/2026-05-11.md")).unwrap(),
        )
        .unwrap();
        assert!(daily.events.is_empty());
    }

    #[test]
    fn lift_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        touch(
            &vault.join("cadence/2026-05-11.md"),
            "---\ntype: daily\ndate: 2026-05-11\nevents:\n- id: e_001\n  title: Standup\n  date: 2026-05-11T09:00:00-04:00\n  duration: 15\n  area: woodshed\n---\n",
        );

        let first = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(first.events_lifted_to_files, 1);

        let second = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(second.events_lifted_to_files, 0);
    }

    /// End-to-end data-safety net for the inline-events lift: a single vault
    /// that mixes the not-yet-migrated state (a daily carrying TWO inline
    /// events) with the already-migrated state (one of those events already
    /// has its own `events/<id>.md`, which the user may have edited). Running
    /// the full migration entry point twice must:
    ///   (a) materialize every inline event as `events/<id>.md`,
    ///   (b) never overwrite the pre-existing event file's body,
    ///   (c) strip the `events:` key from the daily, and
    ///   (d) be a byte-for-byte no-op on the second pass.
    #[test]
    fn migration_lift_events_is_idempotent_on_mixed_vault() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();

        // Daily still in the legacy inline-events shape, with two events.
        touch(
            &vault.join("cadence/2026-05-01.md"),
            "---\ntype: daily\ndate: 2026-05-01\nevents:\n- id: e_already\n  title: Standup\n  date: 2026-05-01T09:00:00-04:00\n  duration: 15\n  area: woodshed\n- id: e_fresh\n  title: Alex 1:1\n  date: 2026-05-01T11:00:00-04:00\n  duration: 30\n  area: acme\n---\n\nMorning notes.",
        );
        // One of those events is ALREADY migrated to its own file and carries
        // distinct, user-authored body content that must survive untouched.
        let preexisting_body = "---\ntype: event\nid: e_already\ntitle: Standup (renamed)\ndate: 2026-05-01T09:00:00-04:00\nduration: 15\narea: woodshed\nattendees: []\nrecurring: none\n---\n\nNotes I already typed into this event.";
        touch(&vault.join("events/e_already.md"), preexisting_body);

        // --- First pass ---
        let first = migrate_legacy_folders(&vault).unwrap();
        // Only e_fresh is newly written; e_already is preserved, not re-lifted.
        assert_eq!(first.events_lifted_to_files, 1);

        // (a) Every inline event now has a file.
        assert!(vault.join("events/e_already.md").is_file());
        assert!(vault.join("events/e_fresh.md").is_file());

        // (b) The pre-existing file's distinct body is intact (not clobbered).
        let already_after_first =
            std::fs::read_to_string(vault.join("events/e_already.md")).unwrap();
        assert_eq!(already_after_first, preexisting_body);

        // (c) The daily no longer carries an `events:` key, body preserved.
        let daily_raw_after_first =
            std::fs::read_to_string(vault.join("cadence/2026-05-01.md")).unwrap();
        assert!(!daily_raw_after_first.contains("events:"));
        let daily_after_first = crate::parsers::parse_daily(&daily_raw_after_first).unwrap();
        assert!(daily_after_first.events.is_empty());
        assert!(daily_after_first.body.contains("Morning notes."));

        // Snapshot the freshly-lifted event file too, so we can prove the
        // second pass touches nothing.
        let fresh_after_first = std::fs::read_to_string(vault.join("events/e_fresh.md")).unwrap();

        // --- Second pass: must be a no-op ---
        let second = migrate_legacy_folders(&vault).unwrap();
        assert_eq!(second.events_lifted_to_files, 0);
        assert_eq!(second.event_files_inlined, 0);
        assert_eq!(second.daily_files_moved, 0);

        // (d) Every file is byte-identical to its post-first-run state.
        assert_eq!(
            std::fs::read_to_string(vault.join("events/e_already.md")).unwrap(),
            already_after_first,
            "pre-existing event file changed on the second pass"
        );
        assert_eq!(
            std::fs::read_to_string(vault.join("events/e_fresh.md")).unwrap(),
            fresh_after_first,
            "lifted event file changed on the second pass"
        );
        assert_eq!(
            std::fs::read_to_string(vault.join("cadence/2026-05-01.md")).unwrap(),
            daily_raw_after_first,
            "daily file changed on the second pass"
        );
    }
}
