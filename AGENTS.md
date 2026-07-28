# Woodshed

This repository contains the Woodshed desktop application. Woodshed is a
local-first knowledge manager whose primary records live in a user-selected
Markdown vault.

This file orients agents working on the application code. It does not assign
an absolute location to either the repository or a user's vault.

## Agent orientation

### Location vocabulary

Use these placeholders in code, documentation, commands, and explanations:

| Placeholder | Meaning |
|---|---|
| `<repo_root>` | The directory containing this `AGENTS.md` and `package.json` |
| `<vault_root>` | The vault directory selected by the user |
| `<app_data_dir>` | The platform-specific Tauri application-data directory |

The repository and vault are separate trees. Neither must be inside the
user's home directory, and their directory names are not significant.

The selected vault path is stored as `vault_path` in
`<app_data_dir>/config.json`. The app reads it through `vault_path_get`.

Onboarding may suggest a path, but the suggestion is not an invariant. Always
treat the configured path as authoritative.

### Scope rules

- For codebase work, operate from `<repo_root>` and follow this file.
- Do not read or mutate vault data unless the user explicitly puts it in scope.
- When vault access is required, discover `<vault_root>` from the app or ask the
  user. Never infer it from the repository location.
- After discovering a vault, read any instructions inside that vault before
  changing its data. Do not assume such instructions exist.
- Keep examples location-neutral. Prefer `<vault_root>/tasks/example.md` over
  a machine-specific absolute path.

### Private-data hygiene

- Treat every value observed in a vault, email, screenshot, runtime UI, log, or
  integration response as private user data, even when it looks harmless or
  publicly recognizable.
- Never copy real names, email addresses, domains, account identifiers, message
  ids, sender labels, subjects, message text, filenames, or other vault-derived
  values into source code, tests, fixtures, snapshots, comments, documentation,
  examples, commit messages, or logs.
- Convert a private reproduction into clearly synthetic data before writing any
  artifact under `<repo_root>`; preserve only the minimal structural shape
  required to exercise the bug.
- Before handoff, scan the complete diff and all new files for private values
  encountered during the task. Replace any match with synthetic placeholders.

## Product invariants

Woodshed is a single-player knowledge OS. Markdown files are the durable source
of truth; the application is a native lens over those files.

- **Files over app.** User-authored records remain readable without Woodshed.
- **One vault, many surfaces.** Cadence, Mail, Agent, Notebook, Resources,
  People, Databases, and Areas share one graph of records.
- **Tags are queryable views.** Frontmatter and inline tags feed tag tables.
- **Wikilinks form the graph.** `[[links]]` resolve records and create backlinks.
- **Local by default.** There is no Woodshed account, telemetry, or operated
  data service.
- **Bounded network actions.** Configured integrations send data only when the
  user invokes them. Opening an HTML email may also load remote images through
  Woodshed's bounded cache; sender HTML never fetches URLs directly.
- **Narrow privilege.** The webview has no general shell or filesystem access.
  Rust exposes scoped commands for specific operations.
- **Derived state is disposable.** Search indexes and calendar caches can be
  rebuilt without losing vault records.

## Development workflow

### Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 on macOS via WKWebView |
| Frontend | React, Vite, TanStack Router, TanStack Query, Tailwind, shadcn/ui |
| Editor | Tiptap with Markdown, slash commands, embeds, tags, and wikilinks |
| Backend | Rust commands, parsers, file I/O, watcher, integrations |
| Search | SQLite FTS5 plus normalized tag and wikilink edges |
| Tests | Vitest, Rust tests, Playwright with `tauri-driver` |

Use Bun for JavaScript commands. Do not substitute npm, pnpm, or yarn.

Install dependencies from `<repo_root>`:

```sh
bun install --frozen-lockfile
```

Run the desktop app for normal development and review:

```sh
bun run tauri:dev
```

Use `bun run dev` only for frontend-only work that does not need Tauri commands
or local file-backed behavior.

### Credential-backed command-line tools

On macOS, the sandbox may not be able to read Keychain items used by tools such
as `gh`, even when the user is already authenticated. Do not treat a
sandbox-only credential failure as proof that the login is invalid. Immediately
repeat the exact read-only authentication check with narrowly scoped escalation,
and ask the user to authenticate only if that escalated check also fails.

Never work around sandboxed credential access by exporting tokens, copying
secrets into plaintext configuration, or printing secret values to logs.

### Reuse the running desktop app

Before live inspection, check for an existing `target/debug/woodshed` process
and its Bun, Tauri, and Vite parents.

If a development instance is running, reuse it. Do not start another session or
disturb its parent processes.

Attach to the existing native process by exact PID. App-name automation can
launch an installed copy of Woodshed and create a misleading second instance.

Inspect the native window first for visual debugging. Browser automation is for
deliberate end-to-end coverage, not default live inspection.

### Verification

Run checks in proportion to the change. The complete suite is:

```sh
bun run build
bun run lint
bun run typecheck
bun run test
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
bun audit
cargo audit --file src-tauri/Cargo.lock
```

Use focused tests while iterating, then run the relevant complete suite before
handoff. A documentation-only change does not require rebuilding the app.

## Architecture and data flow

### Runtime model

The React frontend invokes narrow Tauri commands. Rust validates inputs, reads
or writes vault files, updates derived indexes, and returns serializable DTOs.

TanStack Query owns client-side server state. Query keys follow vault paths so
filesystem events can invalidate only the affected data.

The filesystem watcher observes internal and external edits. Internal writes
carry fingerprints so their watcher echoes do not cause UI flicker.

External edits made by another application are debounced, re-indexed, and
emitted to the frontend as `vault:changed` events.

### Code map

| Path | Responsibility |
|---|---|
| `src/routes/` | TanStack Router routes and route loaders |
| `src/components/` | Surface UI, editors, and shared layout |
| `src/lib/hooks/` | TanStack Query reads, mutations, and invalidation |
| `src/lib/tauri.ts` | Typed frontend boundary for Tauri invocation |
| `src-tauri/src/commands/` | Narrow application commands grouped by domain |
| `src-tauri/src/parsers/` | Markdown and YAML frontmatter schemas |
| `src-tauri/src/vault/` | Safe paths, bounded reads, writes, trash, migrations |
| `src-tauri/src/index/` | FTS5 search and normalized graph indexes |
| `src-tauri/src/gmail/` | Gmail IMAP and SMTP clients |
| `src-tauri/src/gcal/` | iCal parsing, filtering, recurrence, and cache |
| `src-tauri/src/agent/` | Agent transcript records and Hermes protocol |

### Write and reactivity rules

- Resolve record paths through helpers in `src-tauri/src/vault/mod.rs`.
- Treat vault files, mail, calendar feeds, fetched HTML, and model output as
  untrusted input.
- Use bounded readers and reject symlinked collection entries.
- Write records atomically through the vault helpers.
- Record self-write fingerprints and update the search index synchronously.
- Keep watcher handling for external edits idempotent.
- Move destructive record operations into `.woodshed/trash/` when practical.
- Never add generic shell or filesystem permissions to the webview.

iCloud-backed vaults use a direct-write fallback because rename behavior across
the sync boundary is unreliable. Keep that exception inside vault helpers.

### Sources of truth

When documentation and implementation differ, inspect these sources before
changing behavior:

- Vault directories: `VAULT_SUBDIRS` in `src-tauri/src/vault/mod.rs`
- Record schemas: `src-tauri/src/parsers/` and domain-specific renderers
- Registered commands: the invoke handler in `src-tauri/src/lib.rs`
- Routes: `src/routes/` and the generated route tree
- Main navigation: `src/components/layout/sidebar.tsx`
- Permissions: `src-tauri/capabilities/` and Tauri configuration
- Verification commands: `README.md`, `package.json`, and `Cargo.toml`

## Storage model

### Vault data

`<vault_root>` is selected during onboarding, which is the only place the path
is set — `vault_path_set` is invoked from `src/routes/welcome.tsx` alone.
Settings shows the configured vault and can reveal it or rebuild the index, but
has no control for choosing a different one. It contains user-owned source
records and managed attachments.

```text
<vault_root>/
├── tasks/          First-class task records
├── cadence/        Daily journal records
├── events/         Vault events and iCal note attachments
├── people/         Personal CRM records
├── notebook/       Long-form notes
├── resources/      Saved links, highlights, and notes
├── tables/         Database schemas and rows
├── areas/          Area records
├── inbox/          Gmail messages currently in the inbox
├── sent/           Sent messages
├── archive/        Archived messages
├── drafts/         Mail drafts
├── agent/          Agent conversation transcripts
├── sweep/          Mail triage workflow cards
├── data/           Legacy vault metadata read by migrations
├── attachments/    User and mail attachments
└── .woodshed/      Recoverable trash and record revisions
```

`vault_init` creates required directories without overwriting existing data.
Missing runtime directories may also be created by their owning command.

### Non-vault state

Platform-managed state lives under `<app_data_dir>`, not beside the source code
and not necessarily beside the vault.

```text
<app_data_dir>/
├── config.json                 Non-secret settings and account metadata
├── index.db                    Derived FTS5 index
├── gcal-cache/<account>.json   Derived iCal event caches
└── woodshed.log                Rotating application log
```

Credentials and secret integration URLs belong in the operating-system
credential store. Do not add secrets to the vault, `config.json`, fixtures, or
source-controlled environment files.

### Migrations

`watcher_start` runs idempotent vault migrations before normal watching. The
implementation in `src-tauri/src/vault/migration.rs` is authoritative.

Legacy folders and record shapes may remain readable after migration. Preserve
fallbacks unless the change explicitly includes a safe retirement path.

Migrations avoid deleting user-touched directories. Add idempotence, mixed-vault,
and preservation tests whenever migration behavior changes.

## Record model

Most records are Markdown with YAML frontmatter. Frontmatter holds structured
metadata; the body holds user-authored content or a durable transcript.

The parsers and renderers are the schema authority. Preserve unknown or legacy
fields when an existing serializer is designed to round-trip them.

| Record | Canonical location | Key fields |
|---|---|---|
| Daily journal | `cadence/YYYY-MM-DD.md` | `type`, `date` |
| Event | `events/<id>.md` | `type`, `id`, `title`, `date`, `duration`, `area` |
| Task | `tasks/<id>.md` | `type`, `id`, `content`, `status`, `scheduled`, `sort_key` |
| Note | `notebook/<slug>.md` | `type`, `id`, `title`, `created`, `tags`, `area` |
| Person | `people/<slug>.md` | `type`, `id`, `name`, `email`, `area` |
| Resource | `resources/<slug>.md` | `type`, `id`, `title`, `url`, `saved`, `tags` |
| Area | `areas/<id>.md` | `type`, `id`, `name`, `color`, `created` |
| Table schema | `tables/<id>/_schema.md` | `type`, `id`, `columns`, `views` |
| Table row | `tables/<id>/<row>.md` | `type`, `id`, `table`, `cells` |
| Agent chat | `agent/<id>.md` | `type`, `id`, transcript metadata |
| Sweep card | `sweep/<id>.md` | source message, lane, action, status |

Mail records use flat files in `inbox/`, `sent/`, `archive/`, and `drafts/`.
Their account identity is stored in frontmatter.

### Shared conventions

- Frontmatter `id` is canonical even when the filename is a readable slug.
- Notes, people, and resources may set `favorite: true`.
- Notes, tasks, events, and people may reference an `area`.
- Resources intentionally do not belong to one area.
- Frontmatter `tags` and inline `#tags` feed normalized tag edges.
- `[[wikilinks]]` resolve by supported record names or ids.
- Unresolved wikilinks remain valid placeholders.
- Backlinks come from the derivative index and must survive external edits.

### Tasks

Tasks are first-class records, not inline checklist items. Their status is
`backlog`, `in-progress`, or `done`.

Entering `in-progress` starts timing. Leaving it accumulates elapsed time in
`time_spent_seconds` and clears `in_progress_started_at`.

Cadence orders tasks by status, then `sort_key`. Drag reordering writes floating
midpoints between neighboring keys.

### Events and calendars

Vault events live in `events/`. Their Markdown bodies hold meeting notes.
Cadence daily files contain journal content, not the canonical event collection.

iCal metadata lives in the derived calendar cache. Saving notes for an iCal
event creates an attachment record in `events/`; cache metadata wins conflicts.

An event without an explicit area may receive a display-only inferred area from
resolved attendees. Explicit user selection always wins.

Recurrence projection happens at read time. Preserve the original iCal recurrence
data even when the UI uses a simpler recurrence representation.

### Databases and tag tables

Custom databases store one `_schema.md` and one Markdown file per row. Column
and view definitions belong to the schema; cell values belong to row files.

Tag tables query normalized tag edges from SQLite. Do not rescan every vault
collection for each tag view.

`#event` includes vault event records implicitly and merges cached iCal events at
read time.

## Surfaces and routes

The sidebar order is the current product taxonomy and drives `⌘1` through `⌘8`.
Confirm it in `src/components/layout/sidebar.tsx` before changing navigation.

| Surface | Primary route | Backing data |
|---|---|---|
| Cadence | `/` and `/cadence/*` | Daily journals, events, tasks, iCal cache |
| Mail | `/mail` | Inbox, sent, archive, drafts, Sweep cards |
| Agent | `/agent` | Agent chat records and configured endpoint |
| Notebook | `/notebook` | Notes |
| Resources | `/resources` | Saved web resources |
| People | `/people` | Person records and linked activity |
| Databases | `/databases` | Custom tables and tag-generated views |
| Areas | `/areas` | Area records and matching records |

Settings lives under `/settings`. Vault, profile, appearance, accounts, and
Agent configuration have dedicated child routes.

The shell provides persistent navigation, per-surface list and content panels,
tabs, contextual sidebars, and a global command palette.

Use TanStack Router links for internal navigation. Preserve route context when
opening records from Cadence, tag tables, Areas, or backlinks.

## Integrations and trust boundaries

### Gmail

Woodshed talks directly to Gmail through IMAP and SMTP. Each account uses an
email address, sender name, and App Password stored by the OS.

Gmail is the source of truth for inbox membership and `\Seen` state. Refresh
reconciles the full remote inbox before pruning stale Review cards.

Archiving updates Gmail and moves the local record from `inbox/` to `archive/`.
Keep local and remote failure handling recoverable.

### Google Calendar

Google Calendar uses a read-only secret iCal URL. The URL is stored by the OS;
non-secret account metadata is stored in `config.json`.

Sync filters cancelled, declined, uninvolved, and duplicate events. Parsed
events replace the account's JSON cache as one unit.

Per-calendar email lists drive involvement filters. An empty list disables
those filters for that calendar.

### Resource capture and remote content

Route public URL fetches through `src-tauri/src/network.rs`. Enforce HTTPS where
required and preserve time, redirect, address, and response-size limits.

Sanitize fetched HTML at the boundary. Remote email images load through the
bounded cache by default; never let sender HTML fetch remote URLs directly.

### Agent and Sweep

Agent chats are durable vault records. Requests go directly to the configured
Hermes-compatible endpoint only after explicit user action.

Sweep cards are workflow records. `to_review` cards depend on local inbox
membership; queued, working, and done cards may outlive the source email.

Generated actions that create records, archive mail, or otherwise mutate data
must remain visible and user-confirmed at the established command boundary.

### Voice

Dictation and voice mode send microphone audio to Deepgram only when invoked.
Spoken replies use the configured Deepgram Aura voice.

Microphone permission and a user-supplied key are required. Keep production
keys in the OS credential store and development overrides out of Git.

## Privacy and diagnostics

- No account database, analytics, crash reporting, or Woodshed-operated backend.
- No credentials or private vault contents in logs.
- Application failures and sync summaries go to `<app_data_dir>/woodshed.log`.
- The log is size-capped and available through Settings diagnostics.
- React route and root error boundaries must show a copyable error state instead
  of a blank window.
- External integrations receive only the data required for the invoked action.

Read `CONTRIBUTING.md`, `SECURITY.md`, `docs/SECURITY-MODEL.md`, and
`docs/legal/PRIVACY.md` before changing a trust boundary.
