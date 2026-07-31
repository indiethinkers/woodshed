// Daily journal commands. Files live at `vault/cadence/YYYY-MM-DD.md`
// (the cadence/ folder, alongside the iCal cache and any leftover
// legacy files during migration). Get-or-create semantics: daily_get
// always returns a DailyDto, creating the file with empty body if it
// doesn't exist.
//
// Daily files own the inline events array. daily_save is body-only —
// reading the existing file first and writing only `body` back so the
// frontend's autosave loop can't clobber events. Mutations to the
// events array go through the event_create/update/delete commands in
// commands/events.rs.

use crate::parsers;
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyDto {
    pub date: String,
    pub path: String,
    pub body: String,
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

/// Absolute path to a daily file. Lives under cadence/ since the
/// folder consolidation — the legacy daily/ location is still read
/// during migration via the boot-time migrator.
pub(crate) fn daily_path(vault: &Path, date: &str) -> Result<PathBuf, String> {
    vault_lib::validate_daily_date(date)?;
    let dir = vault_lib::cadence_dir(vault);
    let collection = dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "cadence directory has no valid name".to_string())?;
    vault_lib::record_file_path(vault, collection, date)
}

fn rel_daily_path(date: &str) -> Result<String, String> {
    vault_lib::validate_daily_date(date)?;
    Ok(format!("cadence/{}.md", date))
}

pub(crate) fn write_daily(
    state: &State<AppState>,
    abs_path: &Path,
    journal: &parsers::DailyJournal,
) -> Result<(), String> {
    let serialized = parsers::serialize_daily(journal).map_err(|e| e.to_string())?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &serialized).map_err(|e| e.to_string())?;
    Ok(())
}

fn index_daily(
    app: &AppHandle,
    state: &State<AppState>,
    rel_path: &str,
    journal: &parsers::DailyJournal,
) {
    if let Ok(idx) = state.ensure_index(app) {
        if let Err(e) = idx.upsert(&crate::index::doc_from_daily(journal, rel_path)) {
            eprintln!("index daily {}: {}", journal.date, e);
        }
    }
}

/// Append a `- [HH:MM] <text>` log line to today's journal, creating the
/// file when the day hasn't been opened yet. Skips the append when any of
/// `dedupe_labels` already appears as a `[[wikilink]]` in the body — record
/// creation flows (resources, notebook, people) call this so a new file
/// leaves exactly one trace on the day it was made.
pub(crate) fn log_line_on_today(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    text: &str,
    dedupe_labels: &[&str],
) -> Result<(), String> {
    let now = chrono::Local::now();
    let date = now.format("%Y-%m-%d").to_string();
    let timestamp = now.format("%H:%M").to_string();
    let mut journal = read_daily(vault, &date)?.unwrap_or_else(|| parsers::DailyJournal {
        date: date.clone(),
        events: Vec::new(),
        body: String::new(),
    });
    let next_body = append_log_line(&journal.body, &timestamp, text, dedupe_labels);
    if next_body == journal.body {
        return Ok(());
    }

    journal.body = next_body;
    let abs_path = daily_path(vault, &date)?;
    write_daily(state, &abs_path, &journal)?;
    index_daily(app, state, &rel_daily_path(&date)?, &journal);
    Ok(())
}

/// Pure body transform behind `log_line_on_today`. An empty body (or the
/// bare `-` editor placeholder) is replaced by the line; otherwise the line
/// lands at the end of the journal. Legacy empty timestamp bullets
/// (`- [HH:MM]` with no text) are swept first; current editors store intentional
/// empty blocks as bare bullets and preserve them.
pub(crate) fn append_log_line(
    body: &str,
    timestamp: &str,
    text: &str,
    dedupe_labels: &[&str],
) -> String {
    let swept = strip_empty_timestamp_bullets(body);
    let body = swept.as_str();
    if dedupe_labels
        .iter()
        .any(|label| body_contains_wikilink(body, label))
    {
        return body.to_string();
    }

    let line = format!("- [{}] {}", timestamp, text);
    let trimmed = body.trim_end();
    if trimmed.is_empty() || trimmed == "-" {
        line
    } else {
        format!("{trimmed}\n{line}")
    }
}

/// True when a line is a legacy list bullet carrying only a `[HH:MM]`
/// timestamp and no note text — e.g. `- [11:19]`. Current editors timestamp a
/// block only after it receives text, but older records can retain these
/// abandoned stamps.
fn is_empty_timestamp_bullet(line: &str) -> bool {
    let Some(rest) = line.trim().strip_prefix('-') else {
        return false;
    };
    let Some(inner) = rest
        .trim()
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
    else {
        return false;
    };
    let b = inner.as_bytes();
    b.len() == 5
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2] == b':'
        && b[3].is_ascii_digit()
        && b[4].is_ascii_digit()
}

/// Drop empty timestamp bullets from a journal body, preserving every other
/// line and the original ordering. Returns the body untouched when there's
/// nothing to strip so unrelated saves don't churn the file's formatting.
pub(crate) fn strip_empty_timestamp_bullets(body: &str) -> String {
    if !body.lines().any(is_empty_timestamp_bullet) {
        return body.to_string();
    }
    body.lines()
        .filter(|line| !is_empty_timestamp_bullet(line))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn body_contains_wikilink(body: &str, label: &str) -> bool {
    let label = label.trim();
    if label.is_empty() {
        return false;
    }
    body.to_lowercase()
        .contains(&format!("[[{}]]", label.to_lowercase()))
}

/// Read the daily file at `date`. Returns None if the file doesn't
/// exist; the caller decides whether to scaffold a new one.
pub(crate) fn read_daily(
    vault: &Path,
    date: &str,
) -> Result<Option<parsers::DailyJournal>, String> {
    let abs_path = daily_path(vault, date)?;
    if !abs_path.exists() {
        return Ok(None);
    }
    let content = vault_lib::read_record(&abs_path).map_err(|e| e.to_string())?;
    parsers::parse_daily(&content)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn daily_get(app: AppHandle, state: State<AppState>, date: String) -> Result<DailyDto, String> {
    let vault = vault_root(&app)?;
    let abs_path = daily_path(&vault, &date)?;
    let rel_path = rel_daily_path(&date)?;

    if abs_path.exists() {
        let content = vault_lib::read_record(&abs_path).map_err(|e| e.to_string())?;
        let parsed = parsers::parse_daily(&content).map_err(|e| e.to_string())?;
        return Ok(DailyDto {
            date: parsed.date,
            path: rel_path,
            body: parsed.body,
        });
    }

    // Create-on-read: empty journal so the user can start typing without an
    // explicit "create" gesture. The file is written before returning so a
    // subsequent restart finds the same empty document instead of a fresh one.
    let journal = parsers::DailyJournal {
        date: date.clone(),
        events: vec![],
        body: String::new(),
    };
    write_daily(&state, &abs_path, &journal)?;
    index_daily(&app, &state, &rel_path, &journal);
    Ok(DailyDto {
        date,
        path: rel_path,
        body: String::new(),
    })
}

/// True when `next` would replace a substantial journal body with nothing —
/// an empty string or the editor's empty-day scaffold (`- `). A frontend
/// state bug once committed the scaffold over a full day of notes (the
/// 2026-06-10 wipe); the vault is the source of truth, so the backend
/// refuses the shrink outright. Short one-line bodies stay deletable —
/// blocking those would frustrate more than it protects.
pub(crate) fn is_destructive_overwrite(current: &str, next: &str) -> bool {
    if !is_empty_editor_body(next) {
        return false;
    }
    let current = current.trim();
    if is_empty_editor_body(current) {
        return false;
    }
    current.len() >= 80 || current.lines().filter(|l| !l.trim().is_empty()).count() >= 2
}

fn is_empty_editor_body(body: &str) -> bool {
    body.lines().all(|line| {
        let trimmed = line.trim();
        trimmed.is_empty() || trimmed == "-" || is_empty_timestamp_bullet(line)
    })
}

/// Keep the empty-overwrite guard for stale or accidental editor commits, but
/// allow an intentional clear from a client that proves which body it edited.
pub(crate) fn should_refuse_destructive_overwrite(
    current: &str,
    next: &str,
    previous_body: Option<&str>,
) -> bool {
    is_destructive_overwrite(current, next) && previous_body != Some(current)
}

/// True when the client claimed a base (`previous_body`) that no longer
/// matches what's on disk AND the disk body is non-empty — i.e. the disk
/// changed under the editor (for example, an external edit) and writing the
/// editor's stale body would clobber it.
///
/// This complements `should_refuse_destructive_overwrite`, which only fires
/// when the *new* body is empty. A non-empty autosave whose base diverged from
/// disk sails past the empty-overwrite guard and would silently drop the newer
/// content — this catch rejects it so the frontend can re-base on the fresh
/// on-disk body.
pub(crate) fn is_stale_base_overwrite(current: &str, previous_body: Option<&str>) -> bool {
    match previous_body {
        Some(prev) => prev != current && !is_empty_editor_body(current),
        None => false,
    }
}

#[tauri::command]
pub fn daily_save(
    app: AppHandle,
    state: State<AppState>,
    date: String,
    body: String,
    previous_body: Option<String>,
) -> Result<DailyDto, String> {
    let vault = vault_root(&app)?;
    let abs_path = daily_path(&vault, &date)?;
    let rel_path = rel_daily_path(&date)?;
    // Preserve inline events on save. The frontend autosaves the
    // journal body whenever the editor commits; if we built a fresh
    // DailyJournal from `body` alone, every keystroke commit would
    // wipe the day's scheduled events. Read first, patch body, write.
    let mut journal = match read_daily(&vault, &date)? {
        Some(j) => j,
        None => parsers::DailyJournal {
            date: date.clone(),
            events: vec![],
            body: String::new(),
        },
    };
    // Normalize legacy abandoned timestamp bullets before the guards. Current
    // editors represent intentional empty blocks as bare `-` rows, which this
    // cleanup deliberately preserves. Running the guards on the stripped body
    // remains load-bearing for older clients and records.
    let next_body = strip_empty_timestamp_bullets(&body);
    if should_refuse_destructive_overwrite(&journal.body, &next_body, previous_body.as_deref()) {
        crate::log_warn!(
            "daily::save",
            "refused empty-body overwrite of {} (existing body {} bytes)",
            rel_path,
            journal.body.len()
        );
        return Err(format!(
            "refusing to overwrite {} with an empty body while it still has {} characters; edit or delete the file directly to clear it",
            rel_path,
            journal.body.trim().len()
        ));
    }
    // Optimistic-concurrency catch: if the editor's base no longer matches the
    // on-disk body, another writer changed the file since this editor loaded.
    // Writing the stale body would clobber that newer content, so we
    // refuse and signal the frontend to re-base. The `stale-base:` token is
    // load-bearing — the mutation hook detects it to refetch instead of dropping
    // the edit.
    if is_stale_base_overwrite(&journal.body, previous_body.as_deref()) {
        crate::log_warn!(
            "daily::save",
            "refused stale-base overwrite of {} (disk diverged from editor base)",
            rel_path
        );
        return Err(format!(
            "stale-base: {} changed on disk since this editor loaded; reload before saving",
            rel_path
        ));
    }
    journal.body = next_body;
    write_daily(&state, &abs_path, &journal)?;
    index_daily(&app, &state, &rel_path, &journal);
    Ok(DailyDto {
        date,
        path: rel_path,
        body: journal.body,
    })
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

    #[test]
    fn daily_path_lives_under_cadence() {
        let (_tmp, vault) = setup_vault();
        let p = daily_path(&vault, "2026-04-26").unwrap();
        assert!(p.ends_with("cadence/2026-04-26.md"), "got {}", p.display());
    }

    #[test]
    fn append_log_line_appends_to_existing_body() {
        assert_eq!(
            append_log_line(
                "- morning pages",
                "09:12",
                "[[Alex Rivera]]",
                &["alex-rivera"]
            ),
            "- morning pages\n- [09:12] [[Alex Rivera]]"
        );
    }

    #[test]
    fn append_log_line_replaces_empty_placeholder_body() {
        assert_eq!(
            append_log_line("- ", "09:12", "[[Alex Rivera]]", &[]),
            "- [09:12] [[Alex Rivera]]"
        );
    }

    #[test]
    fn destructive_overwrite_blocks_scaffold_over_substantial_body() {
        let body = "- [08:08] Need to test Hubpost CRM for Agents project.\n- [08:28] Revisit estimates for pricing project.";
        assert!(is_destructive_overwrite(body, "- "));
        assert!(is_destructive_overwrite(body, "-"));
        assert!(is_destructive_overwrite(body, ""));
        assert!(is_destructive_overwrite(body, "  \n  "));
        assert!(is_destructive_overwrite(body, "- \n- \n- "));
        assert!(should_refuse_destructive_overwrite(body, "", None));
        assert!(should_refuse_destructive_overwrite(
            body,
            "",
            Some("- [08:08] stale body")
        ));
    }

    #[test]
    fn destructive_overwrite_allows_normal_saves() {
        let body = "- [08:08] Need to test Hubpost CRM for Agents project.\n- [08:28] Revisit estimates for pricing project.";
        // Real content replacing real content is always fine.
        assert!(!is_destructive_overwrite(body, "- [08:08] edited"));
        // Clearing an already-trivial body is fine.
        assert!(!is_destructive_overwrite("", "- "));
        assert!(!is_destructive_overwrite("- ", ""));
        // A short one-liner stays deletable.
        assert!(!is_destructive_overwrite("- quick note", ""));
    }

    #[test]
    fn destructive_overwrite_allows_intentional_clear_from_current_body() {
        let body = "- [08:08] Need to test Hubpost CRM for Agents project.\n- [08:28] Revisit estimates for pricing project.";
        assert!(!should_refuse_destructive_overwrite(body, "", Some(body)));
        assert!(!should_refuse_destructive_overwrite(body, "- ", Some(body)));
        assert!(!should_refuse_destructive_overwrite(
            body,
            "- \n- \n- ",
            Some(body)
        ));
    }

    #[test]
    fn stale_base_overwrite_blocks_when_disk_diverged_from_editor_base() {
        // The editor believed it was editing "old", but another writer
        // appended a bullet in the meantime. The stale autosave must be
        // rejected so it can't clobber the newer note.
        let disk = "old\n- [09:00] newer";
        assert!(is_stale_base_overwrite(disk, Some("old")));
    }

    #[test]
    fn stale_base_overwrite_allows_matching_base() {
        // Normal save: the editor's base matches what's on disk, nothing
        // changed underneath it.
        let body = "old\n- [09:00] newer";
        assert!(!is_stale_base_overwrite(body, Some(body)));
    }

    #[test]
    fn stale_base_overwrite_ignores_absent_base() {
        // No claimed base (older client / first save) — the optimistic check
        // can't reason about divergence, so it stays out of the way.
        assert!(!is_stale_base_overwrite("old\n- [09:00] newer", None));
    }

    #[test]
    fn stale_base_overwrite_ignores_trivial_disk_body() {
        // An empty (or bare-scaffold) disk body has nothing to clobber, so a
        // diverging base is fine — the empty-overwrite guard owns that case.
        assert!(!is_stale_base_overwrite("", Some("old")));
        assert!(!is_stale_base_overwrite("-", Some("old")));
        assert!(!is_stale_base_overwrite("- \n- ", Some("old")));
        assert!(!is_stale_base_overwrite("  \n ", Some("old")));
    }

    #[test]
    fn stale_base_guard_preserves_concurrent_edit_on_disk() {
        // End-to-end-ish on disk: write a substantial daily, then simulate an
        // external edit by appending a bullet to the file. A stale-base
        // autosave must be refused, leaving the newer note intact on disk.
        let (_tmp, vault) = setup_vault();
        let date = "2026-06-11";
        let abs_path = daily_path(&vault, date).unwrap();

        let base_body =
            "- [08:08] Need to test Hubpost CRM for Agents project.\n- [08:28] Revisit estimates.";
        let base_journal = parsers::DailyJournal {
            date: date.to_string(),
            events: vec![],
            body: base_body.to_string(),
        };
        std::fs::write(&abs_path, parsers::serialize_daily(&base_journal).unwrap()).unwrap();

        // Another writer changes the file while the editor still holds `base_body`.
        let updated_body = format!("{base_body}\n- [09:00] ship the fix");
        let updated_journal = parsers::DailyJournal {
            date: date.to_string(),
            events: vec![],
            body: updated_body.clone(),
        };
        std::fs::write(
            &abs_path,
            parsers::serialize_daily(&updated_journal).unwrap(),
        )
        .unwrap();

        // The stale autosave's body and previous_body are both the old base.
        // daily_save reads the newer disk body first.
        let on_disk = read_daily(&vault, date).unwrap().unwrap();
        assert!(
            is_stale_base_overwrite(&on_disk.body, Some(base_body)),
            "guard must flag the divergence"
        );

        // Because the guard fires, daily_save returns Err before writing, so
        // the file on disk still carries the newer note untouched.
        let after = read_daily(&vault, date).unwrap().unwrap();
        assert_eq!(after.body, updated_body);
        assert!(after.body.contains("- [09:00] ship the fix"));
    }

    #[test]
    fn append_log_line_skips_when_label_already_linked() {
        let body = "- met with [[Alex Rivera]] about hiring";
        assert_eq!(
            append_log_line(
                body,
                "09:12",
                "[[Alex Rivera]]",
                &["alex-rivera", "Alex Rivera"]
            ),
            body
        );
    }

    #[test]
    fn strips_abandoned_empty_timestamp_bullets() {
        assert!(is_empty_timestamp_bullet("- [11:19]"));
        assert!(is_empty_timestamp_bullet("  - [09:05] "));
        // A bullet with actual note text is kept.
        assert!(!is_empty_timestamp_bullet("- [11:19] good morning"));
        // The bare scaffold and plain bullets are not timestamp bullets.
        assert!(!is_empty_timestamp_bullet("-"));
        assert!(!is_empty_timestamp_bullet("- a real note"));

        assert_eq!(
            strip_empty_timestamp_bullets("- [11:19]\n- [06:54] good morning."),
            "- [06:54] good morning."
        );
        // Nothing to strip → returned untouched (no formatting churn).
        let clean = "- [06:54] good morning.\n- [07:00] ship it";
        assert_eq!(strip_empty_timestamp_bullets(clean), clean);
    }

    #[test]
    fn empty_dedupe_label_never_matches() {
        assert!(!body_contains_wikilink("- [[]] odd body", ""));
    }

    #[test]
    fn parse_daily_roundtrip_via_serializer() {
        // Belt-and-suspenders: confirm the serializer produces what
        // daily_get's parse path expects to read back.
        let journal = parsers::DailyJournal {
            date: "2026-04-26".to_string(),
            events: vec![],
            body: "morning notes".to_string(),
        };
        let serialized = parsers::serialize_daily(&journal).unwrap();
        let parsed = parsers::parse_daily(&serialized).unwrap();
        assert_eq!(parsed, journal);
    }

    /// Disk-level roundtrip for the daily read-modify-write path. We can't
    /// drive `write_daily` directly in a unit test (it needs a Tauri
    /// `State<AppState>` for the watcher self-write record), but `write_daily`'s
    /// only on-disk effect is `serialize_daily` + `vault_lib::write_atomic` —
    /// exactly what this test performs — and the read side is the real
    /// `read_daily`. The watcher record is a UI-flicker optimization, not a
    /// data-integrity step, so omitting it doesn't weaken the roundtrip.
    /// Critically: any inline `events:` must survive the roundtrip, because
    /// `daily_save` reads-patches-writes to avoid wiping a day's events on
    /// every body autosave.
    #[test]
    fn write_then_read_daily_preserves_body_and_inline_events() {
        let (_tmp, vault) = setup_vault();
        let date = "2026-05-11";

        // Build the journal from real on-disk YAML (one inline event + body)
        // via the production parser, rather than hand-constructing an Event —
        // this also pins the parser to the daily-file shape we ship.
        let raw = "---\ntype: daily\ndate: 2026-05-11\nevents:\n- id: e_001\n  title: Standup\n  date: 2026-05-11T09:00:00-04:00\n  duration: 15\n  area: woodshed\n---\n\n- [08:08] Need to test the CRM.\n- [08:28] Revisit pricing estimates.";
        let journal = parsers::parse_daily(raw).unwrap();
        assert_eq!(journal.events.len(), 1, "fixture should carry one event");

        // Mirror write_daily's on-disk effect (serialize + atomic write).
        let abs_path = daily_path(&vault, date).unwrap();
        let serialized = parsers::serialize_daily(&journal).unwrap();
        vault_lib::write_atomic(&abs_path, &serialized).unwrap();

        // Read back through the real read_daily path.
        let read_back = read_daily(&vault, date)
            .unwrap()
            .expect("daily should exist");
        assert_eq!(read_back.date, journal.date);
        assert_eq!(
            read_back.body, journal.body,
            "body must survive the roundtrip"
        );
        assert_eq!(
            read_back.events, journal.events,
            "inline events must survive the roundtrip (else a body autosave wipes them)"
        );
    }

    /// `read_daily` returns None (not an error) when the day has never been
    /// opened — callers scaffold a fresh journal in that case.
    #[test]
    fn read_daily_returns_none_for_missing_file() {
        let (_tmp, vault) = setup_vault();
        assert!(read_daily(&vault, "2026-12-25").unwrap().is_none());
    }
}
