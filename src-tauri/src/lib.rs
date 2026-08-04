// Woodshed — Tauri shell entry point.
//
// Modules:
//   - vault       : path resolution, scaffolding, atomic write, iCloud detection
//   - parsers     : Task / Event / DailyJournal markdown ↔ struct serialization
//   - watcher     : debounced fs-watcher with self-write filter
//   - state       : id→path map for events
//   - index       : SQLite + FTS5 search index over the vault
//   - gmail       : IMAP/SMTP integration via App Passwords (backs the Mail surface)
//   - gcal        : Google Calendar via iCal subscription URLs (Phase 2a, read-only)
//   - image_cache : disk-backed cache served via the wsmail:// URI scheme so
//                   email images don't re-fetch from the upstream CDN on every open

pub mod agent;
pub mod commands;
pub mod credentials;
pub mod email_render;
pub mod gcal;
pub mod gmail;
pub mod image_cache;
pub mod index;
pub mod logging;
pub mod network;
pub mod parsers;
pub mod state;
pub mod sync_ext;
pub mod vault;
pub mod watcher;
pub mod wikilinks;

use crate::sync_ext::MutexRecover;
use commands::{
    agent as agent_cmd, areas, attachments, config, daily, events, gcal as gcal_cmd,
    gmail as gmail_cmd, logs, mail, notebook, people, resources, search as search_cmd, tables,
    tags, tasks, vault as vault_cmd, watcher as watcher_cmd,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Process-lifetime state shared across Tauri commands.
pub struct AppState {
    /// Vault filesystem watcher. None until `watcher_start` is called by the
    /// frontend (after onboarding or on app boot if vault path is configured).
    pub watcher: Mutex<Option<watcher::VaultWatcher>>,
    /// id → path map for calendar events. Populated on startup by
    /// watcher_start and maintained by event updates/deletes and calendar sync.
    pub events_index: Arc<state::EventIndex>,
    /// Date-bucketed cache of parsed vault-local events. Read by
    /// events_for_date instead of re-scanning + re-parsing `events/`
    /// on every call. Populated alongside events_index at watcher_start
    /// and maintained by the same set of mutations.
    pub events_cache: Arc<state::EventsCache>,
    /// Search index. Lazy-opened on the first vault interaction so a missing
    /// app-data dir never blocks startup. None means "not yet opened" — code
    /// that mutates the index calls `ensure_index` to open-or-reuse.
    pub index: Mutex<Option<Arc<index::IndexHandle>>>,
    /// Persistent IMAP connections for Gmail accounts. Lazy-opened on first
    /// use; reused across sync/archive/mark-read. See `gmail::pool`.
    pub gmail_pool: Arc<gmail::GmailImapPool>,
    /// Serializes local mail read/merge/write sections. Provider calls never
    /// hold this lock; commands re-resolve the message after network awaits.
    pub mail_mutations: Mutex<()>,
    /// Bumped after a successful provider-side mail mutation. Gmail syncs
    /// capture this before fetching. The per-message map below determines
    /// whether a particular fetched record is stale.
    pub mail_mutation_epoch: AtomicU64,
    /// Last provider-mutation epoch for each account-scoped message id.
    /// This keeps a mutation to one message from suppressing authoritative
    /// provider changes to unrelated messages in the same sync batch.
    pub mail_message_epochs: Mutex<std::collections::HashMap<String, u64>>,
    /// In-memory Gmail credentials cache. Avoids repeated app-data reads in a
    /// running session.
    pub gmail_creds: Arc<gmail::CredsCache>,
    /// In-memory cache of parsed iCal events per calendar. Hydrated
    /// from `<app_data_dir>/gcal-cache/<id>.json` on startup; replaced
    /// on every sync. The Cadence query reads this alongside the
    /// markdown files in `cadence/` to merge external + vault-local
    /// events at read time.
    pub ical_cache: Arc<gcal::IcalEventCache>,
    /// Lowercased-email → PersonRef map for attendee resolution. Built
    /// at watcher_start from every `people/*.md` and refreshed whenever
    /// a person file changes. Lets us turn raw iCal attendee emails
    /// into clickable wikilinks at O(1) per attendee.
    pub people_email_index: Arc<state::PeopleEmailIndex>,
    /// Monotonic "vault generation" counter. Bumped on every vault write —
    /// internal writes bump it via `VaultWatcher::record_self_write` (the
    /// chokepoint every command's write funnels through), external edits
    /// bump it from the watcher callback. The `VaultWatcher` holds a clone
    /// of this same `Arc`, so both sides observe one counter. Derived
    /// caches (e.g. the `tag_table` / `tags_with_counts` memos) key on it:
    /// an unchanged generation serves the cached result, a bumped one
    /// forces a recompute. Global by design — any write invalidates all
    /// tags' caches, trading per-tag precision for simplicity.
    pub vault_generation: Arc<AtomicU64>,
    /// Memoized `tag_table` output, keyed `tag -> (generation, rows)`.
    /// A call whose generation matches the cached entry returns the clone
    /// without touching disk; a mismatch uses normalized index edges to parse
    /// only matching records. See `commands::tags::tag_table`.
    pub tag_table_cache:
        Mutex<std::collections::HashMap<String, (u64, Vec<commands::tags::TagTableRow>)>>,
    /// Memoized `tags_with_counts` output, keyed on generation only (the
    /// command takes no per-tag argument). See `commands::tags::tags_with_counts`.
    pub tags_counts_cache: Mutex<Option<(u64, Vec<commands::tags::TagCount>)>>,
    /// Serializes durable Agent run records with their transcript writes.
    /// Network work never holds this lock.
    pub agent_run_mutations: Mutex<()>,
    /// Process-local cancellation signals for jobs owned by this app process.
    /// Persisted queued/running jobs absent from this map are stale after a
    /// restart and are surfaced as recoverable failures.
    pub agent_run_cancellations:
        Mutex<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

impl AppState {
    /// Record a completed provider mutation while serialized against local
    /// mail merge/write sections.
    pub fn record_mail_provider_mutation(&self, message_id: &str) {
        let _guard = self.mail_mutations.lock_recover();
        let epoch = self.mail_mutation_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        self.mail_message_epochs
            .lock_recover()
            .insert(message_id.to_string(), epoch);
    }

    /// Whether this specific message changed after a provider fetch began.
    pub fn mail_message_mutated_after(&self, message_id: &str, epoch: u64) -> bool {
        self.mail_message_epochs
            .lock_recover()
            .get(message_id)
            .is_some_and(|message_epoch| *message_epoch > epoch)
    }

    /// Current vault generation. Read by the tag-table memo to decide
    /// hit vs. recompute.
    pub fn vault_generation(&self) -> u64 {
        self.vault_generation.load(Ordering::Relaxed)
    }

    /// Invalidate tag-derived memos after a whole-index rebuild. A rebuild
    /// changes the index without a vault write, so the normal watcher-backed
    /// generation bump does not run.
    pub fn invalidate_tag_caches(&self) {
        self.vault_generation.fetch_add(1, Ordering::Relaxed);
        self.tag_table_cache.lock_recover().clear();
        *self.tags_counts_cache.lock_recover() = None;
    }

    /// Open the index DB if not yet opened, returning a clone of the handle.
    /// Tauri AppHandle is required because the DB lives under app_data_dir.
    pub fn ensure_index(&self, app: &tauri::AppHandle) -> Result<Arc<index::IndexHandle>, String> {
        if let Some(handle) = self.index.lock_recover().as_ref() {
            return Ok(handle.clone());
        }
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("resolve app_data_dir: {}", e))?;
        let db_path = index::default_db_path(&app_data);
        let handle = index::IndexHandle::open(&db_path)
            .map(Arc::new)
            .map_err(|e| format!("open index: {}", e))?;
        *self.index.lock_recover() = Some(handle.clone());
        Ok(handle)
    }
}

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

fn empty_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("static response builder cannot fail")
}

/// Content-Security-Policy for the rendered email document.
///
/// The sanitizer in `email_render` is the first line of defence; this is the
/// structural one. `default-src 'none'` means no sender markup or CSS can
/// reach the network no matter what slips past sanitization, which is what
/// keeps the invariant that sender HTML never fetches remote URLs directly —
/// remote images only load through the bounded `wsmail://` image cache.
///
/// `'unsafe-inline'` covers Woodshed's own wrapper `<style>` and bridge
/// `<script>`, which are the only style and script in the document. Source
/// lists are schemes rather than `'self'`: the frame is sandboxed without
/// `allow-same-origin`, so its origin is opaque and `'self'` would match
/// nothing.
const EMAIL_BODY_CSP: &str = "default-src 'none'; \
     img-src wsmail: data:; \
     style-src 'unsafe-inline'; \
     script-src 'unsafe-inline'; \
     form-action 'none'; \
     base-uri 'none'";

enum WsmailRoute {
    /// `/img/<urlsafe-b64-of-original-url>` — resolved upstream URL.
    Img(String),
    /// `/body/<message-id>` — message id (URL-decoded).
    Body(String),
}

/// Parse a wsmail:// URI into its dispatch target. Returns `None` for
/// anything we don't recognize so the handler can surface a 400.
fn wsmail_route(uri: &str) -> Option<WsmailRoute> {
    if uri.len() > 16 * 1024 {
        return None;
    }
    let after_scheme = uri.split_once("://")?.1;
    let path = after_scheme.split_once('/')?.1;
    let path = path.split(['?', '#']).next().unwrap_or(path);
    if path.starts_with("img/") {
        return image_cache::decode_image_path(uri)
            .ok()
            .map(WsmailRoute::Img);
    }
    if let Some(rest) = path.strip_prefix("body/") {
        let rest = rest.trim_end_matches('/');
        if rest.is_empty() || rest.len() > 2_048 {
            return None;
        }
        let decoded = percent_decode(rest);
        if decoded.len() > 1_024 || decoded.chars().any(char::is_control) {
            return None;
        }
        return Some(WsmailRoute::Body(decoded));
    }
    None
}

/// Tiny percent-decoder for the `/body/<id>` path segment.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(b);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(10 + b - b'a'),
        b'A'..=b'F' => Some(10 + b - b'A'),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // SPA fallback for the tauri:// protocol. Every Vite bundle is
        // served from a single /index.html — the client router takes over
        // from there. Any non-asset path that misses the literal lookup
        // (i.e. /people/cameron-patel, /cadence/2026-05-13) falls back to the
        // SPA shell. Static assets (.js, .css, image extensions, etc.)
        // still 404 on miss so broken references are visible instead of
        // silently served as HTML.
        .register_asynchronous_uri_scheme_protocol("tauri", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            let resolver = app.asset_resolver();

            let asset = resolver.get(path.clone()).or_else(|| {
                let leaf = path.rsplit('/').next().unwrap_or("");
                let looks_like_static_asset =
                    leaf.contains('.') && !leaf.ends_with(".html") && !leaf.ends_with(".htm");
                if looks_like_static_asset {
                    return None;
                }
                resolver.get("/index.html".to_string())
            });

            let response = match asset {
                Some(asset) => {
                    let mut builder = tauri::http::Response::builder().status(200);
                    builder = builder.header("Content-Type", &asset.mime_type);
                    if let Some(csp) = &asset.csp_header {
                        builder = builder.header("Content-Security-Policy", csp);
                    }
                    builder
                        .body(asset.bytes)
                        .unwrap_or_else(|_| empty_response(500))
                }
                None => empty_response(404),
            };
            responder.respond(response);
        })
        // wsmail://localhost/<kind>/<key>
        //
        //   /img/<urlsafe-b64-of-original-url>
        //     Resolves to the on-disk image cache, fetching the upstream
        //     URL once on miss.
        //
        //   /body/<message-id>
        //     Returns the rendered + sanitized email body. The
        //     `email_body_render` command populates the cache before the
        //     iframe asks for the URL.
        .register_asynchronous_uri_scheme_protocol("wsmail", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let uri = request.uri().to_string();
            tauri::async_runtime::spawn(async move {
                let response = match wsmail_route(&uri) {
                    Some(WsmailRoute::Img(target_url)) => {
                        match image_cache::get_or_fetch(&app, &target_url).await {
                            Ok((bytes, content_type)) => tauri::http::Response::builder()
                                .status(200)
                                .header("Content-Type", content_type)
                                .header("Cache-Control", "public, max-age=31536000, immutable")
                                .body(bytes)
                                .unwrap_or_else(|_| empty_response(500)),
                            Err(_) => {
                                eprintln!("wsmail image fetch failed");
                                empty_response(502)
                            }
                        }
                    }
                    Some(WsmailRoute::Body(id)) => {
                        match image_cache::read_rendered_body(&app, &id).await {
                            Ok(Some(bytes)) => tauri::http::Response::builder()
                                .status(200)
                                .header("Content-Type", "text/html; charset=utf-8")
                                .header("Cache-Control", "no-store")
                                .header("Content-Security-Policy", EMAIL_BODY_CSP)
                                .body(bytes)
                                .unwrap_or_else(|_| empty_response(500)),
                            Ok(None) => {
                                eprintln!("wsmail body cache miss for {id}");
                                empty_response(404)
                            }
                            Err(e) => {
                                eprintln!("wsmail body read error: {e}");
                                empty_response(500)
                            }
                        }
                    }
                    None => {
                        eprintln!("wsmail malformed uri: {uri}");
                        empty_response(400)
                    }
                };
                responder.respond(response);
            });
        })
        // ⇧⌘W (close-window) is the only menu item we drive ourselves; ⌘W is
        // deliberately left unbound by the menu so the web layer can claim it
        // to close the active tab (see tabs-context).
        .on_menu_event(|app, event| {
            if event.id().0.as_str() == "close_window" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
        })
        .setup(|app| {
            // Resolve the app data dir and bring up the persistent log
            // file as early as possible — before any command runs — so
            // a panic in the very first command is captured. The path
            // resolution can fail only when Tauri's path resolver is
            // borked, which would mean every other path resolution is
            // also broken; in that case we just stay on stderr-only.
            if let Ok(app_data) = app.path().app_data_dir() {
                logging::init(&app_data);
            }

            if let Err(error) = config::cleanup_removed_integration(app.handle()) {
                crate::log_warn!(
                    "config::migration",
                    "obsolete integration cleanup will retry next launch: {error}"
                );
            }

            // macOS application menu, built explicitly rather than left to
            // Tauri's default. The default Window→Close item binds ⌘W, and
            // AppKit consumes that key equivalent before it ever reaches the
            // web view — so ⌘W always closed the whole window. Here ⌘W is left
            // unbound (the web layer uses it to close the active tab) and the
            // window-close affordance moves to ⇧⌘W, mirroring browser tabs.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

                let handle = app.handle();

                let app_menu = SubmenuBuilder::new(handle, "Woodshed")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(handle, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let view_menu = SubmenuBuilder::new(handle, "View").fullscreen().build()?;

                let close_window = MenuItemBuilder::new("Close Window")
                    .id("close_window")
                    .accelerator("Shift+Cmd+W")
                    .build(handle)?;

                let window_menu = SubmenuBuilder::new(handle, "Window")
                    .minimize()
                    .item(&close_window)
                    .build()?;

                let menu = MenuBuilder::new(handle)
                    .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
                    .build()?;

                app.set_menu(menu)?;
            }

            Ok(())
        })
        .manage(AppState {
            watcher: Mutex::new(None),
            events_index: Arc::new(state::EventIndex::new()),
            events_cache: Arc::new(state::EventsCache::new()),
            index: Mutex::new(None),
            gmail_pool: Arc::new(gmail::GmailImapPool::new()),
            mail_mutations: Mutex::new(()),
            mail_mutation_epoch: AtomicU64::new(0),
            mail_message_epochs: Mutex::new(std::collections::HashMap::new()),
            gmail_creds: Arc::new(gmail::CredsCache::new()),
            ical_cache: Arc::new(gcal::IcalEventCache::new()),
            people_email_index: Arc::new(state::PeopleEmailIndex::new()),
            vault_generation: Arc::new(AtomicU64::new(0)),
            tag_table_cache: Mutex::new(std::collections::HashMap::new()),
            tags_counts_cache: Mutex::new(None),
            agent_run_mutations: Mutex::new(()),
            agent_run_cancellations: Mutex::new(std::collections::HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            config::vault_path_get,
            config::vault_path_set,
            config::vault_path_default,
            config::demo_clock_get,
            config::profile_get,
            config::profile_set,
            config::integration_refresh_settings_get,
            config::integration_refresh_settings_set,
            config::warning_dismissed_get,
            config::warning_dismiss,
            agent_cmd::agent_config_get,
            agent_cmd::agent_config_set,
            agent_cmd::agent_config_clear,
            agent_cmd::agent_connection_test,
            agent_cmd::agent_attachment_prepare,
            agent_cmd::agent_chat_stream,
            agent_cmd::agent_run_create,
            agent_cmd::agent_run_get,
            agent_cmd::agent_runs_for_conversation,
            agent_cmd::agent_runs_by_ids,
            agent_cmd::agent_runs_active,
            agent_cmd::agent_run_cancel,
            agent_cmd::agent_chats_all,
            agent_cmd::agent_chat_get,
            agent_cmd::agent_chat_create,
            agent_cmd::agent_chat_update,
            agent_cmd::agent_chat_delete,
            vault_cmd::vault_init,
            vault_cmd::vault_import,
            vault_cmd::vault_switch,
            vault_cmd::vault_is_icloud,
            vault_cmd::vault_git_sync,
            vault_cmd::vault_reveal,
            vault_cmd::external_url_open,
            watcher_cmd::watcher_start,
            attachments::attachment_save,
            tasks::task_create,
            tasks::task_get,
            tasks::task_update,
            tasks::task_timer_pause,
            tasks::task_timer_resume,
            tasks::task_reorder,
            tasks::task_delete,
            tasks::tasks_for_date,
            tasks::tasks_all,
            daily::daily_get,
            daily::daily_save,
            events::event_get,
            events::event_update,
            events::event_delete,
            events::events_for_date,
            events::event_ical_get,
            events::event_ical_save_notes,
            people::person_create,
            people::person_update,
            people::person_delete,
            people::person_avatar_set,
            people::person_avatar_clear,
            people::people_all,
            notebook::note_create,
            notebook::note_get,
            notebook::note_update_body,
            notebook::note_update_title,
            notebook::note_update_metadata,
            notebook::note_delete,
            notebook::notes_all,
            resources::resource_create,
            resources::resource_capture_url,
            resources::resource_get,
            resources::resource_update,
            resources::resource_delete,
            resources::resources_all,
            areas::areas_get,
            areas::area_create,
            areas::area_update,
            areas::area_delete,
            tables::table_create,
            tables::table_get,
            tables::table_update,
            tables::table_delete,
            tables::tables_all,
            tables::database_tag_favorites_get,
            tables::database_tag_favorite_set,
            tables::row_create,
            tables::row_get,
            tables::row_update,
            tables::row_delete,
            tables::row_reorder,
            tables::rows_all,
            tags::tag_table,
            tags::tags_with_counts,
            search_cmd::search,
            search_cmd::wikilink_targets,
            search_cmd::wikilink_backlinks,
            search_cmd::wikilink_outgoing,
            search_cmd::wikilink_graph,
            search_cmd::vault_reindex,
            // Mail (Gmail-backed; provider-agnostic disk ops live in mail.rs)
            mail::mail_get_full,
            mail::mail_open_attachment,
            mail::mail_inbox_page,
            mail::mail_inbox_unread_count,
            mail::mail_folder_page,
            mail::mail_get_local,
            mail::mail_thread,
            mail::mail_mark_read,
            mail::mail_archive_one,
            mail::mail_snooze,
            mail::mail_restore_due_snoozes,
            mail::mail_delete_one,
            mail::mail_draft_save,
            mail::mail_drafts_list,
            mail::mail_draft_delete,
            mail::email_body_render,
            gmail_cmd::gmail_account_set,
            gmail_cmd::gmail_accounts_list,
            gmail_cmd::gmail_account_update,
            gmail_cmd::gmail_account_remove,
            gmail_cmd::gmail_inboxes_list,
            gmail_cmd::gmail_sync_recent,
            gmail_cmd::gmail_send,
            gmail_cmd::gmail_reply,
            // Google Calendar (Phase 2a — iCal subscription, read-only)
            gcal_cmd::gcal_account_add,
            gcal_cmd::gcal_accounts_list,
            gcal_cmd::gcal_account_update,
            gcal_cmd::gcal_account_remove,
            gcal_cmd::gcal_ical_sync,
            gcal_cmd::event_ical_dismiss,
            // Logging — frontend writes JS errors here, settings reads back.
            logs::logs_event,
            logs::logs_tail,
            logs::logs_path,
            logs::logs_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Woodshed");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sanitizer keeps sender CSS now, so this header is what actually
    /// guarantees the invariant that sender HTML never fetches remote URLs
    /// directly. Remote images must still come from the bounded image cache.
    #[test]
    fn the_email_body_csp_permits_no_network_origin() {
        assert!(EMAIL_BODY_CSP.starts_with("default-src 'none'"));
        for forbidden in ["http:", "https:", "*", "'unsafe-eval'"] {
            assert!(
                !EMAIL_BODY_CSP.contains(forbidden),
                "{forbidden} must not appear in the email body CSP"
            );
        }
        assert!(EMAIL_BODY_CSP.contains("img-src wsmail: data:"));
        // `'self'` is meaningless here: the frame is sandboxed without
        // allow-same-origin, so its origin is opaque and would match nothing.
        assert!(!EMAIL_BODY_CSP.contains("'self'"));
    }

    #[test]
    fn wsmail_routes_split_images_from_bodies_and_reject_junk() {
        assert!(matches!(
            wsmail_route("wsmail://localhost/body/abc123"),
            Some(WsmailRoute::Body(id)) if id == "abc123"
        ));
        assert!(wsmail_route("wsmail://localhost/other/abc").is_none());
        assert!(wsmail_route("not-a-uri").is_none());
    }
}
