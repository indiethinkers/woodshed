# Woodshed

This is the source repository for **Woodshed**, a desktop-first knowledge management app. The user's vault (the data) lives at `~/woodshed/`; this repo (`~/Code/woodshed/`) is the app that reads and writes those files.

If you're an AI working on the **codebase**, this file is your orientation. If you're working on the **vault data**, see `~/woodshed/CLAUDE.md` instead.

---

## Product

Woodshed unifies email, calendar (the **Cadence** surface), notes, tasks, saved web links (the **Resources** surface), structured tables, and a personal CRM into a single workspace. Every record is a markdown file with YAML frontmatter, stored locally on the user's computer.

**Core thesis:** Woodshed is a single-player knowledge OS where everything is a markdown file, tags are databases, people are nodes, and an AI layer connects what you'd never connect yourself.

**Philosophy:**
- **File over app** — every record is a `.md` file in `~/woodshed/`. The app is a lens, not a cage.
- **Seven surfaces, one vault** — Calendar, Mail, Notebook, People, Databases, Resources, Areas are lenses into the same set of files.
- **Tags are tables** — any `#hashtag` automatically generates a queryable view.
- **Wikilinks are the graph** — `[[double bracket links]]` connect files across types and surface as backlinks.
- **The AI layer surfaces connections and acts only when invoked** — Woodshed highlights relationships passively; Agent and AI Sweep commands require explicit user action.
- **No Woodshed-operated server.** No accounts. No telemetry. The user owns the files and chooses any external integrations.

---

## Architecture

| Layer | Stack |
|---|---|
| Shell | Tauri 2 (native macOS via WKWebView) |
| Frontend | Vite + TanStack Router + TanStack Query + shadcn/ui + Tailwind |
| Editor | Tiptap (markdown body editor with slash commands and block embeds) |
| Backend | Rust (`src-tauri/`) — file I/O, watcher, indexer, parsers |
| Storage | Markdown files with YAML frontmatter under `~/woodshed/` |
| Reactivity | Filesystem watcher (`notify` + debouncer) emits `vault:changed` events; TanStack Query path-routes invalidation |
| Search | SQLite FTS5 index at `<app_data_dir>/index.db`, derived from the vault |
| Settings | `tauri-plugin-store` JSON config (vault path, profile, theme, dismissed warnings) |
| Tests | `cargo test` (Rust unit + integration), `vitest` (frontend unit), `@playwright/test` + `tauri-driver` (E2E) |

**Development run modes.**
- Use Bun for JavaScript commands in this repo (`bun run ...`), not npm, pnpm, or yarn.
- Use `bun run tauri:dev` when running or reviewing the app. Woodshed is desktop-first; there is no supported Codex in-app browser runtime or loopback web backend.
- Use bare `bun run dev` only when explicitly doing frontend-only Vite work that does not need Tauri commands or local file-backed behavior.
- **Reuse the running desktop app.** Before live inspection, check whether the user's existing `bun run tauri:dev` session is already running (`target/debug/woodshed` with its Bun/Tauri/Vite parent processes). If it is, do not start another dev session and do not use app-name GUI automation: targeting `Woodshed` by name can launch the installed `/Applications/Woodshed.app` as a second instance. Attach only to the existing dev process by its exact PID, using a mechanism that cannot launch an application. Never disturb the original Bun/Tauri/Vite parent processes. If an installed-app instance is launched accidentally, close only that installed-app process and leave the dev process running.
- **Inspect the native instance first.** For visual debugging or UI review, attach directly to the user's already-running `target/debug/woodshed` process by exact PID and inspect that native window. Do not substitute Playwright or browser automation for inspecting the running desktop app. Playwright remains appropriate for deliberate automated E2E coverage, not as the default live-inspection tool.

**Trust posture:** the vault is the source of truth. The SQLite index is a derivative — losing it triggers a one-shot rebuild. Gmail App Passwords, Google Calendar secret URLs, Hermes API keys, and Deepgram keys live in the operating-system credential store, never the vault or `config.json`; legacy plaintext values are migrated and scrubbed on first read. There is no Woodshed-operated server; data leaves the device only for an integration the user configures and explicitly invokes.

**Reactivity model:** every Rust command writes a file atomically (temp + rename), records a self-write fingerprint, and updates the search index synchronously. The watcher fires for both internal and external edits; self-writes are filtered before the frontend invalidation event so the UI doesn't flicker. External edits (made in Obsidian, VS Code, anywhere) reflect in the running app within ~500ms.

---

## Information Architecture

Three-panel layout, persistent across all surfaces:

```
┌──────────┬──────────┬─────────────────────────┐
│ Sidebar  │ List     │ Content                 │
│ 52px     │ ~220px   │ flex                    │
│  rail    │  panel   │                         │
└──────────┴──────────┴─────────────────────────┘
```

- **Sidebar (left, 52px rail):** icon-only nav with `⌘,` for settings. Hidden on `/welcome`.
- **List panel (middle):** context-specific list — tasks for today, events on a date, notes by recency, people sorted by interaction.
- **Content panel (right):** renders the selected record. Layout adapts to `type:` frontmatter.

### Sidebar nav

```
●         (BrandMark)

Cadence
Notebook
Resources
People
Databases
Mail
Areas
─────────────
Settings    ⌘,
```

### Command palette (`⌘K`)

A global FTS5-backed palette opens with `⌘K`. Three result sources, grouped:

1. **Pages** — substring match against nav.
2. **Days** — `today` / `yesterday` / `tomorrow` (prefix-matched) resolve to the cadence route for that date, recomputed every search.
3. **Vault hits** — ranked FTS5 results across tasks, events, daily journals, notes, people, and resources.

Newly created records are searchable immediately (the indexer runs synchronously inside each command). External edits are picked up by the watcher and re-indexed within ~500ms.

---

## The Seven Surfaces

### 1. Cadence (default route, `/`)

Daily journal + calendar in one. The page the user lands on every morning. Vault-local events (created via **+ Add event**) live alongside Google Calendar events (subscribed via iCal — see "Google Calendar integration" below). (Surface renamed from "Calendar" to "Cadence" in May 2026; the underlying record type is still `event`.)

**Routes:**
- `/` — today's daily page
- `/cadence/[date]` — a specific day
- `/cadence/event/[id]` — vault-local event detail (Tiptap-editable meeting notes body + metadata)
- `/cadence/event/ical/[account]/[externalId]` — iCal event detail (read-only metadata from gcal-cache + editable meeting-notes body persisted to `events/<synthetic_id>.md`)
- `/cadence/[date]/task/[id]` — task detail rendered in context of its scheduled day
- `/databases/tags/[tag]` — auto-generated tag table; `#event` is the canonical example (rows = every event in the vault + every iCal-cached event). (Moved under the Databases surface June 2026; old `/tags/*` links redirect.)

**Files:**
- `cadence/YYYY-MM-DD.md` — daily journal body only. One file per day. (Through May 2026, daily files also carried an inline `events:` array; that array has been lifted out to per-file events — see below — and the boot migration drains any remaining inline entries on first launch.)
- `events/<id>.md` — one file per vault-local event. Frontmatter holds metadata; markdown body is the user's meeting notes (Tiptap-editable). For iCal events, a notes attachment lands at `events/<synthetic_id>.md` with `provider: ical` in frontmatter on first save — metadata is snapshotted from the cache (cache wins on conflict).

**Area inference:** an event whose `area` is empty (always the case for iCal events — the feed carries no area — and possible for vault-local events) gets one inferred from its attendees at read time. Each attendee votes: a person in the People folder votes their own `area`; an unmatched iCal attendee votes their email domain's area (from a domain→area map built off People records, *excluding* generic free-mail providers like gmail/outlook so one personal contact can't tint every meeting). The plurality area wins (ties broken by area id). This is display-only and non-destructive — nothing is written to disk; the moment the user pins an area explicitly in the picker, that value wins on the next read. Lives in `commands::events::infer_area_from_attendees`, applied in `enrich_resolved_attendees` (event detail + cadence schedule) and the `#event` tag table.

**Daily file shape:**
```yaml
type: daily
date: 2026-05-11
---

[freeform daily journal body]
```

**Vault-local event file shape:**
```yaml
type: event
id: e_01HM3Z
title: 1:1 with Alex
date: 2026-05-11T08:00:00-04:00
duration: 30
area: acme
attendees: [alex-rivera]
recurring: weekly                # optional, default "none"
tags: [1on1]                     # optional; `#event` is implicit from type
---

# Meeting notes

[freeform body — Tiptap-editable on the detail page]
```

**Schedule block (Cadence page):** every event row is a link — clicking opens the event's detail page where the user takes meeting notes. Title renders at foreground color with a hover underline (same wikilink pattern used elsewhere); the layout (time on left, title on right) telegraphs the schedule, and the click affordance is discovered on hover. Matches the app's no-chromatic commitment.

**Content panel:** date arrows (← / →) flank the date label + calendar popover at the top, plus auto-rendered schedule block, freeform journal body (debounced autosave), tasks rail (drag-orderable), Woodshed insight card (planned). The Sync calendars button at the bottom of the schedule block pulls the latest Google Calendar events on demand.

**Recurrence:** vault-local events use a `none | daily | weekly | monthly` enum, expanded in Rust at query time. The query layer also projects recurring iCal events from the cache using the same enum (Google Calendar's richer `RRULE` shapes are lowered to this enum; the original `RRULE:` line is preserved on the cached event for future fidelity). RFC 5545 RRULE rendering is deferred.

#### Google Calendar integration (Phase 2a — iCal subscription, read-only)

Users connect a Google Calendar by pasting its **Secret address in iCal format** (Google Calendar → Settings → [Calendar] → Integrate calendar) in `/settings/accounts`. The desktop binary fetches each configured URL on demand via the Sync button, parses the `.ics` with the `ical` crate, and caches the result. No OAuth, no server, no Google verification paperwork (OAuth bidirectional sync — Phase 2b — is deferred).

**Storage layout:**
- Non-secret account metadata lives in the Tauri config store under `gcal_accounts` (`id / displayName / color / emails / lastSyncedAt / lastError / urlConfigured`). The secret iCal URL lives in the operating-system credential store under the account id. Legacy plaintext URLs are migrated and scrubbed on first use.
- Parsed events live in `<app_data_dir>/gcal-cache/<account-id>.json`, one JSON file per calendar, replaced wholesale on each sync. In-memory `IcalEventCache` in `AppState` is hydrated from disk on startup.

**Filter pipeline at sync time** (per-calendar, gated on `emails` being non-empty):
- `STATUS:CANCELLED` → drop
- `RECURRENCE-ID` overrides → drop (master VEVENT handles projection)
- Dedupe by UID
- `RRULE` lowered to the `none | daily | weekly | monthly` enum (`FREQ=` only; `INTERVAL≠1` and `FREQ=YEARLY` drop to `none`). `UNTIL=` extracted into `rrule_until` and enforced at query time so old recurrences don't ghost-project forever
- **DECLINED** filter: skip events where any of the user's per-calendar emails appears as `ATTENDEE` with `PARTSTAT=DECLINED`
- **Involvement** filter: skip events where none of the user's emails appears as `ORGANIZER` or `ATTENDEE`

Per-calendar `emails: Vec<String>` (rather than the global profile email) because users often have separate addresses per workspace (e.g. personal Gmail AND workspace alias both apply to the same calendar). Empty list disables both filters for that calendar.

**Logging.** Sync writes a one-line summary to `<app_data_dir>/woodshed.log` per pass, e.g.: `filter (gcal_..., parsed=3035, declined=12, uninvolved=137, kept=2886)`. Surface via Settings → Vault → Diagnostics → Show last 200 lines.

### 2. Mail

Unified inbox client backed by Gmail (IMAP + SMTP via App Passwords). The user connects one or more Gmail accounts in `/settings/accounts` (per-account email + App Password + sender name); Woodshed lists every connected account and presents a single flat list across all of them. Each row carries a small color dot (deterministic from the account id) so it's clear at a glance which account a message came from. A dropdown in the toolbar scopes the list to one account. (The Mail surface was AgentMail-backed through June 2026; that integration was removed and Gmail is now the sole courier.)

**Auth.** Per-account Gmail App Passwords. There is no Woodshed-operated server and no OAuth — the desktop binary talks directly to Gmail's IMAP/SMTP servers. App Passwords live in the operating-system credential store; legacy plaintext values are migrated and removed from `config.json`.

**Read state.** Presence of the `read` label (equivalently, absence of `unread`) is the source of truth, mirrored to Gmail via IMAP `\Seen`. Archive = removing the message from the Gmail INBOX (which also marks it read) plus moving the local file from `inbox/` to `archive/`.

**Pull cadence.** Manual refresh only for v1 — the user clicks Refresh and Woodshed pulls the recent-N window from each connected account. A periodic background poll is sketched in `src/lib/mail-lib/mail.ts` but commented out.

**Gmail inbox reconciliation.** Gmail is the source of truth for inbox membership. Each `gmail_sync_recent` pulls the recent-N window AND fetches the *full* set of message ids currently in the Gmail INBOX (header-only `(UID ENVELOPE)` via `imap_client::fetch_inbox_ids`); any local `inbox/` file for that account whose id isn't in the live set has been archived/handled directly in Gmail, so `reconcile_gmail_inbox` archives it locally (moves `inbox/`→`archive/`). This stops already-handled mail from lingering in the sweep's Review lane. The reconcile compares the *full* inbox (not just the sync window) so older still-present messages aren't evicted, normalizes both sides through `strip_brackets`, never evicts a message just synced this pass, and bails (no eviction) if the inbox reports `EXISTS>0` but parses zero ids. The count surfaces in the refresh log ("Cleared N already handled in Gmail").

**Sweep card pruning.** The sweep lanes (Review/Queued/Working/Done) are driven by `sweep/<id>.md` *cards*, which outlive their source email — done/queued/working cards stay as history. A `to_review` card is the exception: it represents pending review of an inbox message, so once that email leaves `inbox/` (reconciled out, or archived anywhere) the card is stale. `rowsByLane` hides orphaned `to_review` cards (email no longer present) from Review, and `sweep_discard_orphans` (run after each refresh) deletes their files. It keys off local `inbox/` membership. Count surfaces as "Cleared N stale cards from Review."

**Vault layout.** `inbox/<message-id>.md`, `sent/<message-id>.md`, `archive/<message-id>.md`, `drafts/<ulid>.md` — all flat, with an `inbox:` field (`gmail:<email>`) in frontmatter naming which account the record belongs to.

### 3. Notebook (`/notebook`)

Long-form thinking — essays, drafts, ideas, research notes.

**Files:** `notebook/<slug>.md`. Slug is derived from title at create time; collisions get `-2`, `-3`.

**Editor:** Tiptap with Notion-style slash commands, image upload, YouTube/X embeds for paste-recognized URLs, and inline wikilinks.

```yaml
type: note
id: file-over-app-philosophy
title: File-over-app philosophy
area: indie-thinkers
created: 2026-04-12T12:30:00-04:00
tags: [essay, idea]
```

Notes, people, and resources also accept an optional `favorite: true` frontmatter flag (omitted when false). Starred records surface in the surface's Favorites list panel on the index page; toggled via the star in the detail-page header or the hover star on index-table rows.

### 4. People (`/people`)

Personal CRM. Every person has a page that aggregates linked notes, events, and (eventually) emails.

**Files:** `people/<slug>.md`. Slug is the lower-kebab name; `id` in frontmatter is canonical.

```yaml
type: person
id: alex-rivera
name: Alex Rivera
initials: AR
role: Software Engineer
company: Acme
email: alex@acme.com
relationship: Former teammate  # optional free text, user-maintained
area: acme
color: teal
avatar: /attachments/alex.jpg   # optional
```

### 5. Databases (`/databases`)

Notion-style structured data. The persistence layer for tag tables and custom databases. (Surface renamed from "Tables" to "Databases" in June 2026; routes live at `/databases` with a redirect from the old `/tables`. The vault directory and the `type: table` / `type: row` frontmatter are unchanged — storage is still `tables/`. The virtual "Tasks" table was removed; the auto-generated `#task` tag table is its replacement.)

**Files:** nested as `tables/<table-id>/_schema.md` (column + view definitions) and `tables/<table-id>/<row-id>.md` (one row per file).

**Column types:** `text | number | select | multi_select | checkbox | date`. **Number formats:** `number | us_dollar | euro | british_pound | japanese_yen | percent` with optional `precision`. **View types:** `table` and `board`. Calendar / gallery / list views are deferred.

```yaml
# tables/budget/_schema.md
type: table
id: budget
name: Budget
created: 2026-04-27T10:00:00
columns:
  - { id: col_item, name: Item, type: text }
  - { id: col_amount, name: Amount, type: number, format: us_dollar }
  - { id: col_category, name: Category, type: select, options: [...] }
views:
  - id: view_all
    name: All Transactions
    type: table
    sorts: [{ column: col_amount, direction: desc }]
    filters: { op: and, conditions: [] }
    calculations: { col_amount: sum }
```

```yaml
# tables/budget/row_001.md
type: row
id: row_001
table: budget
created: 2026-04-27T10:05:00
cells:
  col_item: Coffee
  col_amount: 4.5
  col_category: opt_food
```

Tag tables (auto-generated from `#hashtag` usage) ship via `/databases/tags/[tag]` (under the Databases layout, so the Databases sidebar persists; the legacy top-level `/tags/*` routes redirect) — the SQLite derivative index maintains normalized tag→path edges from frontmatter `tags:` arrays and inline `#tag` usage. The backend `tag_table` command queries those edges and parses only matching records into the generic Title/Type/Date/Area table; it does not rescan every collection for each tag view. Clicking a row opens the source file's detail page. `#event` is special-cased: every vault-local record with `type: event` gets an implicit edge (no explicit `event` in `tags:` needed), and iCal-cached events surface alongside it from the in-memory calendar cache.

### 6. Resources (`/resources`)

Saved web links + highlights.

```yaml
type: resource
id: local-first-software
title: Local-first software
url: https://www.inkandswitch.com/local-first/
source: inkandswitch.com
saved: 2026-04-10T09:15:00
tags: [local-first, philosophy]
highlights:
  - "Seven ideals for local-first software"
  - "Cloud apps are not permanent"
```

The body is the user's notes; `highlights` is structured for a future browser-extension capture path.

### 7. Areas (`/areas`, `/areas/[id]`)

Areas of focus — project-level slicing across work records. Notes, tasks, events, and people can carry an `area:` field; resources intentionally do not, because the same source can support multiple areas. Clicking an Area surfaces a unified chronological view of matching area-scoped records, plus the area's own description page. (Renamed from "Spaces"; existing files with the legacy `space:` frontmatter key still parse via a serde alias.)

**Files:** `areas/<id>.md`, one per area. Frontmatter holds the area's metadata (name, color); the body is freeform markdown — purpose, key people, history, related notes.

```yaml
type: area
id: woodshed
name: Woodshed
color: "#378ADD"
created: 2026-05-10T15:00:00-07:00      # optional; absent on areas migrated from JSON
```

Areas were JSON-only (`data/areas.json`) until May 2026. The boot migration scaffolds one `areas/<id>.md` per JSON entry the first time a vault opens with the new build; un-migrated vaults still work via a JSON read-fallback.

Defaults seeded by the onboarding flow: Woodshed, Indie Thinkers, Tech Twitter, Post In Black, Personal.

---

## Tasks

First-class records (not inline checkboxes). One file per task at `tasks/<ULID>.md`. Surfaced on the Cadence tasks rail when `scheduled` matches the displayed day.

```yaml
type: task
id: t_01HM3X9YQK4N7VEWS3M0PG2T8B
content: Ship pricing rewrite
status: backlog | in-progress | done
area: woodshed
created: 2026-04-23T14:22:00-04:00
scheduled: 2026-04-25                  # optional, YYYY-MM-DD
tags: [task]
time_spent_seconds: 1234               # optional, accumulator
in_progress_started_at: 2026-04-25T... # optional, set while running
sort_key: 1714075320000.0              # manual ordering
```

**Time tracking:** entering `in-progress` records `in_progress_started_at`; leaving accumulates elapsed seconds into `time_spent_seconds` and clears the timestamp. The UI shows live elapsed time for an active run.

**Sort:** `status` (in-progress → backlog → done) then `sort_key` (drag-reorder writes f64 midpoints between neighbors).

---

## Tags & Wikilinks

**Tags:** inline `#hashtag` syntax in any markdown body. Pill colors: `#task` purple, `#essay` teal, `#idea` amber, `#backlink` blue, `#outreach` coral, `#sponsor` green. Custom tags inherit a deterministic palette color.

**Wikilinks:** `[[Double bracket links]]` connect records by name or id. `[[Alex Rivera]]` resolves to `people/alex-rivera.md`. Unresolved wikilinks render as future-placeholders, not errors. Every record's content panel surfaces backlinks below the body.

---

## Woodshed AI Layer (planned)

A contextual card at the bottom of content panels. Not a chatbot — a passive layer that reads the vault and surfaces insights:

- **Connection surfacing:** "Sam mentioned [[Morgan]] and the [[ingestion pipeline]]. You have a [[1:1 with Morgan]] at 4:30 today."
- **Dropped-ball detection:** "Alex said he'd draft an RFC last week — no file exists yet."
- **Aggregation:** "You have 5 back-to-back 1:1s this morning. Want me to pull their latest updates?"
- **Pattern recognition:** "You tagged 3 new #idea entries this week — want to review them before your Saturday writing session?"

Visual treatment: gray card, 3px purple left border, "Woodshed" label in purple, muted body text with inline wikilinks and tag pills.

---

## Vault Structure

```
~/woodshed/
├── AGENTS.md          ← canonical orientation file (CLAUDE.md is a one-line @import)
├── CLAUDE.md          ← @AGENTS.md
├── tasks/             ← One file per task, filename = ULID
├── cadence/           ← Daily files (YYYY-MM-DD.md, journal body only — events
│                        have moved to events/). Was: separate daily/ and
│                        cadence/<slug>.md
├── events/            ← One file per event (vault-local and iCal-note attachments).
│                        Body is the meeting notes; frontmatter is metadata.
│                        Was: inline events: array in cadence/<date>.md
├── people/            ← Contacts
├── notebook/          ← Long-form notes
├── resources/         ← Saved links + highlights
├── tables/            ← Notion-style tables, nested as <id>/_schema.md + <id>/<row>.md
├── areas/             ← One file per area (was: data/areas.json)
├── inbox/             ← Gmail-synced messages
├── sent/              ← Outbound mail (one file per send)
├── archive/           ← Archived messages (moved out of inbox/)
├── drafts/            ← In-progress compose/reply drafts
├── data/              ← Vault-level config (legacy areas.json/spaces.json read-fallback only)
└── attachments/       ← Binary blobs referenced from notes
```

**Boot-time migrations** (idempotent, run on every `watcher_start`, skipped on iCloud paths):
- `calendar/` → `cadence/` (May 2026 surface rename)
- `data/spaces.json` → `data/areas.json` → per-file `areas/<id>.md` records
- `daily/<date>.md` → `cadence/<date>.md` (folder consolidation)
- Legacy `cadence/<slug>-<date>.md` event files → inlined into their day's `cadence/<date>.md` `events:` frontmatter array (transitional state)
- Inline `events:` arrays in `cadence/<date>.md` → lifted out to one file per event at `events/<id>.md`; the daily file's `events:` key is removed (events now have their own page where the user takes meeting notes)
- Leftover `cadence/gcal-*.md` files from the pre-cache iCal implementation → swept (the iCal cache now lives in `<app_data_dir>/gcal-cache/`, never in the vault)

Folder migrations leave the old folder in place (empty) after moving — users can `rmdir` if they want; we don't delete user-touched dirs ourselves. Read paths fall back to the remaining legacy locations if the new ones are missing — see `vault::cadence_dir` / `commands::areas::read_areas`.

Scaffolded by `vault_init` on first run; idempotent on re-run. The "Reset & re-scan" button under Settings → Vault rebuilds the FTS5 index from disk and re-creates any missing subdirs.

**Non-vault state** (lives in `<app_data_dir>`, not `~/woodshed/`):
- `config.json` — Tauri store: vault path, profile, theme, Gmail/Google Calendar account metadata
- `index.db` — SQLite FTS5 search index (derivative; can be wiped, triggers a rebuild)
- `gcal-cache/<account-id>.json` — one JSON per connected Google Calendar (parsed iCal events, replaced on each sync)
- `woodshed.log` — persistent log file, capped at 1 MiB with single-generation rotation

The vault path renders as a mono-font pill in the top-right of every content panel header. Reinforces "it's just a file."

**Logging & diagnostics.** Every Tauri command failure, every gcal sync, every uncaught JS error caught by the global handler in `Providers` lands in `<app_data_dir>/woodshed.log` AND streams to stderr (visible in `bun run tauri:dev`). Surface in-app via Settings → Vault → Diagnostics → Show last 200 lines. The React tree is wrapped in route-level (`app/error.tsx`) and global (`app/global-error.tsx`) error boundaries that replace the white-screen-of-death with a copyable error blob.

---

## Onboarding (`/welcome`)

Two-step takeover on first launch. No login, no account, no server.

**Step 1 — Vault location:** path input pre-filled with `~/woodshed/`, native folder picker, "Seed with sample content" checkbox. iCloud paths trigger an inline note (writes degrade to direct-write fallback).

**Step 2 — Profile:** display name + email. Used as the "from" identity in mail and cadence. Stored in `<app_data_dir>/config.json`, never sent anywhere.

On confirm: `vault_init` scaffolds the subdirs, copies seed files if requested, writes the profile to the store, starts the watcher, and fades to `/`.

---

## Settings (`/settings`)

Three-panel layout, four sub-routes:

| Route | Contents |
|---|---|
| `/settings/vault` | Vault path, file count + watcher status, Open in Finder, Reset & re-scan (rebuilds the FTS5 index), Diagnostics (log file path, Open log, Show last 200 lines) |
| `/settings/profile` | Display name + email, autosave-on-blur with a 1500ms "Saved" confirmation |
| `/settings/appearance` | Theme segmented control (System / Light / Dark), instant CSS-variable swap |
| `/settings/accounts` | Gmail accounts (per-account email + app password + sender name), Google Calendars (per-calendar URL + emails + color), voice & dictation (Deepgram key + Aura voice picker) |

A persistent dismissible banner pattern at the top of `/settings` is the convention for surfacing iCloud warnings and watcher failures.

---

## Privacy Posture

- **No accounts.** Woodshed has no users database. The product is a desktop app, full stop.
- **No telemetry.** No analytics, no crash reporting, no phone-home.
- **No Woodshed-operated server.** The desktop binary talks directly to Gmail's IMAP/SMTP servers and Google Calendar's iCal endpoint. Gmail App Passwords, secret iCal URLs, Hermes API keys, and Deepgram keys live in the operating-system credential store. Legacy plaintext secrets are migrated out of `config.json` and scrubbed on first read. Every write — send, reply, archive, sync — is user-initiated.
- **Local SQLite index is derived.** It can be wiped without losing data.
- **iCal event cache is derived.** Lives in `<app_data_dir>/gcal-cache/`; can be wiped, regenerated by next Sync.
- **AI Sweep sends selected email content to the configured Hermes endpoint (opt-in).** Opening the Sweep view does not transmit anything. An explicit Refresh & triage, manual triage, or card command sends the relevant email metadata/body and instruction directly to the user-configured agent endpoint; Woodshed does not proxy or retain that request on a Woodshed server.
- **Remote email images are blocked by default.** Sender-controlled image URLs are removed during sanitized rendering. The app fetches them only after the user chooses Load remote images, through an SSRF-safe, size-bounded cache.
- **Voice features send mic audio to Deepgram (opt-in).** Dictation (the composer mic) and voice mode send short microphone clips to **Deepgram** for speech-to-text, and voice mode plays back replies synthesized by **Deepgram Aura**. It requires macOS Microphone permission and a user-supplied Deepgram key (OS keychain in release, `.env.local` in dev); nothing is sent unless you start dictation or open voice mode. (The earlier meeting-recording feature — mic + system-audio capture transcribed by Deepgram and summarized by Anthropic — was removed; see Implementation Status.)

---

## Implementation Status

| Phase | Scope | Status |
|---|---|---|
| Phase 0 | SPA mode, type extensions, vault foundation, watcher, parsers, tests | ✅ shipped |
| Phase 1 | Welcome flow, settings (4 routes), profile + theme persistence | ✅ shipped |
| Phase 2 | Tasks vertical: file-backed CRUD, sidebar, optimistic mutations | ✅ shipped |
| Phase 3 | Calendar vertical: events, recurrence enum, slug rename | ✅ shipped |
| Phase 3.5 | Daily journal persistence with debounced autosave | ✅ shipped |
| Phase 4 | SQLite FTS5 search index, palette migration, date keywords, live indexing | ✅ shipped |
| — | Notebook, People, Resources, Databases CRUD (file-backed) | ✅ shipped |
| — | Mail surface backed by AgentMail (list inboxes, sync, send, reply, archive, drafts) | ❌ removed (June 2026 — Gmail is the sole courier) |
| Phase 5 (Gmail) | Gmail IMAP/SMTP via App Passwords — multi-account, read + send + reply + archive | ✅ shipped |
| Phase 5 (GCal 2a) | Google Calendar via iCal subscription — per-calendar URL/emails, declined + involvement filters, in-memory + JSON-on-disk cache | ✅ shipped |
| — | Daily-into-cadence merge: events inline as frontmatter on `cadence/YYYY-MM-DD.md`; `daily/` folder retired | ✅ shipped (then superseded by file-per-event May 2026) |
| — | File-per-event in `events/<id>.md` with Tiptap meeting-notes body; iCal notes attach via `events/<synthetic_id>.md` on first save | ✅ shipped |
| — | Tag-tables surface: `/databases/tags/[tag]` with backend `tag_table` command; `#event` is the first concrete consumer | ✅ shipped |
| — | Event titles are clickable links (foreground + hover underline, wikilink pattern) | ✅ shipped |
| — | Persistent log file + React error boundaries + tauriInvoke error capture | ✅ shipped |
| — | Voice dictation (composer mic) + voice mode via Deepgram STT / Aura TTS | ✅ shipped |
| — | Meeting recording (mic+system audio via Swift `woodshed-recorder` sidecar → Deepgram + Anthropic → event notes) | ❌ removed (echo bleed + speaker-ducking side effects) |
| — | Auto-update | ⏳ planned |
| — | Semantic search via QMD as a Tauri sidecar | ⏳ deferred |
| — | Woodshed AI insight cards | ⏳ planned |
| — | Per-type tag-table columns (events get Attendees/Duration; tasks get Status; etc.) | ⏳ planned |
| — | Vault import wizard (Obsidian / Logseq / Bear / Apple Notes) | ⏳ planned |
| — | Recurring tasks, full RFC 5545 RRULE rendering | ⏳ deferred |
| Phase 2b (GCal) | Google Calendar OAuth — full bidirectional sync, write-back, per-instance overrides | ⏳ deferred until OAuth verification completes |

---

## Out of Scope (intentional)

- Cloud sync / multi-device. Use git, iCloud, or Dropbox on the vault folder if you want it.
- Mobile. Desktop only — there's a "best at 900px+" overlay below that breakpoint.
- Multi-user collaboration. Woodshed is single-player.
- Conflict resolution for concurrent multi-device edits.
- Server-side data of any kind.
- Agents surface and MCP server integration. Removed in May 2026; do not scaffold `agents/` / `agent/`, parse or index `agent_session` files, or add a Woodshed MCP binary unless explicitly requested.
