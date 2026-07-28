# Woodshed — Tauri shell

This directory holds the Rust + Tauri 2 shell that wraps the Vite-built UI
as a native macOS app. Pilot target is macOS-only; Windows/Linux are post-raise.

## One-time setup (Day 1)

1. Install Rust if you don't have it:
   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
2. Install the Tauri CLI globally (or use the dev-dep via bun):
   ```sh
   cargo install tauri-cli --version "^2"
   ```
3. Install JS deps from the project root:
   ```sh
   cd .. && bun install
   ```
4. Generate icon set from the brand-mark PNG (shipped at
   `assets/brand-mark.png`, 1024×1024):
   ```sh
   cargo tauri icon assets/brand-mark.png
   ```
   This writes `src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.icns,icon.ico}` referenced in `tauri.conf.json`.

## Daily dev loop

From the project root:

```sh
bun run tauri:dev
```

This runs `vite` (the `beforeDevCommand` in `tauri.conf.json`), waits
for `http://localhost:5173`, and opens a native Tauri window pointing at
that URL. HMR works for the frontend. Rust changes require Ctrl+C +
restart.

Sanity-check the IPC bridge from the browser devtools console:

```js
await window.__TAURI__.core.invoke('ping')
// → "pong"
```

## Production build (macOS)

```sh
bun run tauri:build
```

Runs `vite build` to emit `dist/` (one `index.html` + assets), then
bundles a signed `.dmg` and `.app` from
`src-tauri/target/release/bundle/macos/`.

The SPA shell is served via the `tauri://` URI scheme: any path that
doesn't resolve to a bundled asset falls back to `dist/index.html` and
the client-side TanStack Router takes over. No `generateStaticParams`
ceremony — dynamic routes (`/people/$id`, `/cadence/$date`, etc.) just
work without prerender placeholders.

## What's wired

- Tauri 2 app shell loading the Vite + TanStack Router SPA.
- Plugins: `dialog` and `store`. `deep-link` and `updater` are
  reserved for a later milestone and commented in `Cargo.toml`.
- The `main` window receives only the dialog permission it needs. Vault,
  attachment, log, and external-link operations are narrow Rust commands;
  the webview has no general filesystem or shell capability.
- Custom URI scheme `wsmail://` for email-body and image-cache fetches.
- File watcher (`notify` + `notify-debouncer-mini`, 250ms debounce) with
  per-path self-write fingerprinting so internal writes don't bounce.
- SQLite FTS5 search index (`rusqlite` with bundled SQLite) at
  `<app_data_dir>/index.db`. Path-routed via the watcher to keep external
  edits indexed.
- Markdown parsers (`gray_matter`) for every record type (task, event,
  daily, note, person, resource, area, table, row).
- Tauri commands across every surface — tasks, daily journals, events,
  people, notebook, resources, areas, tables, mail, gmail
  (IMAP/SMTP), gcal (iCal subscription), search, watcher control,
  vault init, config, and the persistent log file.
- Gmail integration via IMAP + SMTP + App Passwords (no OAuth, no
  CASA audit). Prompt-free owner-only storage through `CredentialBroker`, with
  the former `Woodshed Gmail` Keychain entries accepted for one-time migration.
  Multi-account.
- Google Calendar integration via iCal subscription (no OAuth, no
  Google verification). Secret URLs live in the operating-system credential
  store; non-secret metadata stays in the Tauri store. Parsed events cache as JSON in
  `<app_data_dir>/gcal-cache/<id>.json`. Multi-calendar with
  per-calendar emails driving the DECLINED + involvement filters.
- Gmail integration via IMAP/SMTP using per-account App Passwords
  (`gmail` module) — the sole courier for the Mail surface.
- Persistent log file at `<app_data_dir>/woodshed.log` with 1 MiB
  rotation, fed by both Rust (`logging.rs`) and the frontend (via the
  `logs_event` Tauri command). Surfaced in Settings → Vault →
  Diagnostics.

## What's NOT wired

| Status      | What                                                              |
|-------------|-------------------------------------------------------------------|
| ⏳ deferred  | Google Calendar OAuth (Phase 2b) — bidirectional write, per-instance overrides, full RRULE rendering. Waiting on Google OAuth verification. |
| ⏳ deferred  | Semantic search via QMD as a Tauri sidecar.                       |
| ⏳ planned   | `tauri-plugin-updater` + GitHub release channel.                  |
| ⏳ planned   | Woodshed AI insight cards.                                        |
| ⏳ planned   | Vault import wizard (Obsidian / Logseq / Bear / Apple Notes).     |

## Code signing + notarization (CI)

The pilot `.dmg` ships through GitHub Releases with `tauri-action`. CI
needs these secrets in the GitHub repo settings:

- `APPLE_CERTIFICATE` — base64 of the Developer ID `.p12`
- `APPLE_CERTIFICATE_PASSWORD` — password for the `.p12`
- `APPLE_SIGNING_IDENTITY` — e.g. `"Developer ID Application: Example Developer (TEAMID)"`
- `APPLE_ID` — Apple ID email
- `APPLE_PASSWORD` — app-specific password for notarization
- `APPLE_TEAM_ID` — 10-char Team ID

CI workflow lands as part of Lane C in Week 1.
