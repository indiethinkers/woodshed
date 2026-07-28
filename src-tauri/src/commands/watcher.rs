// Watcher boot command. Frontend calls watcher_start after vault path is
// known (either on app boot if vault is configured, or after onboarding).
// Idempotent: re-calling is a no-op while a watcher is already running.

use crate::commands::events;
use crate::sync_ext::MutexRecover;
use crate::watcher::{VaultChange, VaultWatcher};
use crate::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
enum ChangeKind {
    Modified,
    Removed,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VaultChangePayload {
    path: String, // vault-relative
    kind: ChangeKind,
}

fn change_to_payload(vault_root: &Path, change: &VaultChange) -> Option<VaultChangePayload> {
    let (path, kind) = match change {
        VaultChange::Modified(p) => (p, ChangeKind::Modified),
        VaultChange::Removed(p) => (p, ChangeKind::Removed),
    };
    let rel = path.strip_prefix(vault_root).ok()?;
    Some(VaultChangePayload {
        path: rel.to_string_lossy().to_string(),
        kind,
    })
}

#[tauri::command]
pub fn watcher_start(
    app: AppHandle,
    state: State<AppState>,
    vault_path: String,
) -> Result<(), String> {
    // Hold the startup guard for the full synchronous initialization. This
    // prevents two concurrent IPC calls from both observing `None` and
    // granting asset scopes for different vaults.
    let mut watcher_guard = state.watcher.lock_recover();
    if watcher_guard.is_some() {
        return Ok(());
    }

    let vault_root = PathBuf::from(&vault_path)
        .canonicalize()
        .map_err(|e| format!("canonicalize vault path: {}", e))?;

    // Make sure every canonical subdir in VAULT_SUBDIRS exists, even on
    // vaults scaffolded before that constant added a new entry. Idempotent.
    // Without this, a long-lived vault that pre-dates newer canonical
    // subdirs can miss empty folders the migration has no files to create.
    crate::vault::ensure_dirs(&vault_root)
        .map_err(|e| format!("validate vault directories: {e:#}"))?;

    // One-shot migration: calendar→cadence, spaces.json→areas.json,
    // daily/<d>.md→cadence/<d>.md,
    // and inlining of legacy cadence/<slug>-<d>.md event files into the
    // day's daily frontmatter. Runs before the index rebuild so the
    // index sees post-migration paths, and before the watcher starts so
    // we don't fire change events for the moves themselves.
    let mut migration_changed = false;
    match crate::vault::migrate_legacy_folders(&vault_root) {
        Ok(report) => {
            migration_changed = report.cadence_files_moved
                + report.resource_files_normalized
                + report.area_files_created
                + report.daily_files_moved
                + report.event_files_inlined
                + report.events_lifted_to_files
                > 0
                || report.spaces_json_migrated;
            if migration_changed {
                crate::log_info!(
                    "vault::migration",
                    "cadence={}, resources_normalized={}, areas.json={}, area_files={}, daily_moved={}, events_inlined={}, events_lifted={}",
                    report.cadence_files_moved,
                    report.resource_files_normalized,
                    report.spaces_json_migrated,
                    report.area_files_created,
                    report.daily_files_moved,
                    report.event_files_inlined,
                    report.events_lifted_to_files
                );
            }
            if report.skipped_icloud {
                crate::log_warn!("vault::migration", "skipped (iCloud path)");
            }
        }
        Err(e) => crate::log_error!("vault::migration", "{}", e),
    }

    match crate::commands::mail::migrate_gmail_thread_ids(&vault_root) {
        Ok(0) => {}
        Ok(count) => {
            migration_changed = true;
            crate::log_info!(
                "mail::migration",
                "account-scoped {count} legacy thread ids"
            );
        }
        Err(error) => crate::log_error!("mail::migration", "{error}"),
    }

    // One-shot cleanup: sweep any `cadence/gcal-*.md` files left over
    // from the pre-cache iCal sync implementation. The first pass ran
    // for ~30 seconds and tried to write thousands of files; many made
    // it to disk before the renderer crashed, polluting cadence/. The
    // sweep is idempotent — finds nothing on a clean vault.
    match crate::gcal::cache::cleanup_legacy_cadence_files(&vault_root) {
        Ok(0) => {}
        Ok(n) => crate::log_info!("gcal::cleanup", "swept {n} legacy cadence/gcal-*.md files"),
        Err(e) => crate::log_error!("gcal::cleanup", "legacy sweep failed: {e}"),
    }

    // Second sweep: pre-cache `events/g_<calendar>_<id>_<datetime>Z.md`
    // per-event files. Without `provider: ical` in their frontmatter
    // they read as vault-local events, double-counting against the
    // iCal cache projection on the same date — and surviving even
    // after the source meeting is deleted from Google. Only files
    // whose body is the auto-generated "Synced from Google Calendar"
    // placeholder are removed; anything the user wrote stays.
    match crate::gcal::cache::cleanup_legacy_per_event_files(&vault_root) {
        Ok(0) => {}
        Ok(n) => crate::log_info!(
            "gcal::cleanup",
            "swept {n} legacy events/g_*.md placeholder files"
        ),
        Err(e) => crate::log_error!("gcal::cleanup", "per-event sweep failed: {e}"),
    }

    // Cold-load the events id→path map and the date-bucketed events cache
    // from disk. Subsequent create/update/delete commands maintain both
    // incrementally; a watcher event on an events/ or cadence/ path triggers
    // a rebuild below.
    if let Err(e) = events::rebuild_index(&vault_root, &state.events_index, &state.events_cache) {
        eprintln!("rebuild events index failed: {}", e);
    }

    // Cold-load the email→person index so attendee resolution is
    // ready before the first cadence read. Refreshed below by any
    // watcher event touching people/ and synchronously by
    // person_create / _update / _delete.
    state
        .people_email_index
        .replace(crate::commands::people::build_email_index(&vault_root));
    crate::log_info!(
        "people::index",
        "hydrated email index ({} entries)",
        state.people_email_index.len()
    );

    // Hydrate the iCal event cache from <app_data_dir>/gcal-cache/*.json
    // so events from previously-synced calendars are visible immediately,
    // without needing a fresh fetch.
    match crate::gcal::cache::load_from_disk(&app, &state.ical_cache, Some(&vault_root)) {
        Ok(0) => {}
        Ok(n) => crate::log_info!(
            "gcal::cache",
            "hydrated {n} calendars ({} total events)",
            state.ical_cache.len()
        ),
        Err(e) => crate::log_error!("gcal::cache", "hydrate failed: {e}"),
    }

    // Open the search index and, on first run, scan the vault to populate it.
    // Subsequent boots inherit a primed DB and skip the rebuild — except
    // when the boot migration above moved files (paths changed; the old
    // search rows would now 404).
    //
    // The rebuild walks every supported subdir and re-parses every file —
    // 5-10s on a 2000-file vault. Run it on a background thread so the
    // UI is interactive immediately and search results trickle in as the
    // scan progresses. Emit start/done events for a quiet UI indicator.
    let index_handle = state.ensure_index(&app)?;
    let tag_index_stale = index_handle
        .requires_tag_index_rebuild()
        .unwrap_or_else(|e| {
            crate::log_error!("index", "tag index version check failed: {}", e);
            true
        });
    let should_rebuild = match index_handle.document_count() {
        Ok(0) => true,
        Ok(_) => migration_changed || tag_index_stale,
        Err(e) => {
            crate::log_error!("index", "document_count failed: {}", e);
            false
        }
    };
    if should_rebuild {
        let app_for_rebuild = app.clone();
        let vault_for_rebuild = vault_root.clone();
        let index_for_rebuild = index_handle.clone();
        std::thread::spawn(move || {
            crate::log_info!("index", "rebuilding from vault (background)");
            let _ = app_for_rebuild.emit("index:rebuild:start", ());
            match index_for_rebuild.rebuild_from_vault(&vault_for_rebuild) {
                Ok(count) => {
                    crate::log_info!("index", "rebuild complete: {count} documents");
                    let _ = app_for_rebuild.emit("index:rebuild:done", count);
                }
                Err(e) => {
                    crate::log_error!("index", "rebuild failed: {}", e);
                    let _ = app_for_rebuild.emit("index:rebuild:error", e.to_string());
                }
            }
        });
    }

    let app_handle = app.clone();
    let root_for_callback = vault_root.clone();
    let events_index = state.events_index.clone();
    let events_cache = state.events_cache.clone();
    let people_email_index = state.people_email_index.clone();
    let index_for_callback: Arc<crate::index::IndexHandle> = index_handle.clone();
    // Share the vault generation counter with the watcher. The callback
    // below bumps it for external edits (which the self-write filter has
    // already let through); record_self_write bumps it for internal writes.
    let generation_for_callback = state.vault_generation.clone();
    let watcher = VaultWatcher::start(&vault_root, move |changes| {
        // Any external edit the watcher surfaces here has already passed
        // the self-write filter, so it's a genuine outside change. Bump
        // the generation so the tag-table memo recomputes on next read.
        generation_for_callback.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut events_touched = false;
        let mut people_touched = false;
        for change in &changes {
            let path = match &change {
                VaultChange::Modified(p) | VaultChange::Removed(p) => p,
            };
            let top = path
                .strip_prefix(&root_for_callback)
                .ok()
                .and_then(|r| r.iter().next())
                .and_then(|s| s.to_str());
            if let Some(seg) = top {
                if seg == crate::vault::EVENTS_DIR
                    || seg == crate::vault::CADENCE_DIR
                    || seg == crate::vault::LEGACY_CALENDAR_DIR
                {
                    events_touched = true;
                }
                if seg == "people" {
                    people_touched = true;
                }
            }
        }
        if events_touched {
            // Rebuild before broadcasting vault:changed so refetches kicked
            // off by the UI never observe the cache while rebuild_index has
            // cleared it but not repopulated it yet.
            if let Err(e) = events::rebuild_index(&root_for_callback, &events_index, &events_cache)
            {
                eprintln!("rebuild events index after watcher event: {}", e);
            }
        }
        if people_touched {
            // External edit to a person file: refresh the email→person
            // index so the next cadence render picks up the new mapping
            // (e.g. user added an email to a Alex Rivera record; future
            // attendee resolutions should link to them).
            people_email_index.replace(crate::commands::people::build_email_index(
                &root_for_callback,
            ));
        }
        for change in changes {
            let path = match &change {
                VaultChange::Modified(p) | VaultChange::Removed(p) => p,
            };
            // Refresh the search index for external (non-self-write) edits.
            // Self-writes from our own commands have already updated the
            // index synchronously; the watcher's self-write filter dropped
            // those before we got here, so anything we see now is external.
            if let Err(e) = index_for_callback.refresh_path(&root_for_callback, path) {
                eprintln!("index refresh {}: {}", path.display(), e);
            }
            if let Some(payload) = change_to_payload(&root_for_callback, &change) {
                let _ = app_handle.emit("vault:changed", payload);
            }
        }
    })
    .map_err(|e| e.to_string())?;

    // Attach the shared generation counter so internal writes
    // (record_self_write is the chokepoint they funnel through) bump it
    // and the tag-table memo invalidates without a watcher round-trip.
    watcher.set_vault_generation(state.vault_generation.clone());

    // Grant the only runtime asset scope after every fallible startup step has
    // completed. `watcher_start` is process-idempotent while the watcher is
    // present, so no second vault can accumulate another scope in this
    // process; a failed startup grants nothing.
    app.asset_protocol_scope()
        .allow_directory(vault_root.join("attachments"), true)
        .map_err(|e| format!("allow vault attachments: {e}"))?;

    *watcher_guard = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watcher::VaultChange;
    use std::path::PathBuf;

    #[test]
    fn change_payload_strips_vault_root() {
        let vault = PathBuf::from("/tmp/vault");
        let change = VaultChange::Modified(PathBuf::from("/tmp/vault/tasks/abc.md"));
        let payload = change_to_payload(&vault, &change).unwrap();
        assert_eq!(payload.path, "tasks/abc.md");
        matches!(payload.kind, ChangeKind::Modified);
    }

    #[test]
    fn change_payload_returns_none_for_outside_paths() {
        let vault = PathBuf::from("/tmp/vault");
        let change = VaultChange::Modified(PathBuf::from("/elsewhere/foo.md"));
        assert!(change_to_payload(&vault, &change).is_none());
    }
}
