# Woodshed

Woodshed is a desktop-first, local-first knowledge management app. Notes,
tasks, calendar entries, people, resources, tables, and synced mail are plain
Markdown files in a vault you control. The application is a native Tauri shell
over a React interface; it does not require a Woodshed account or backend.

> Woodshed is under active development. Back up your vault before using a
> development build with important data.

## Principles

- Files over app: the Markdown vault is the source of truth.
- Local by default: there is no telemetry or Woodshed-operated data service.
- Explicit integrations: network actions happen only after the user configures
  and invokes Gmail, iCal, Hermes, Deepgram, or resource capture.
- Narrow privilege: the webview has no general shell or filesystem permission;
  Rust commands expose scoped vault and attachment operations.

## Current platform

macOS is the supported desktop target. The architecture is portable through
Tauri, but Windows and Linux packaging are not currently maintained.

## Development

Prerequisites:

- [Bun](https://bun.sh/) 1.3.13
- stable Rust with Cargo
- the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for macOS

Install and run the native app:

```sh
bun install --frozen-lockfile
bun run tauri:dev
```

Frontend-only Vite mode is available as `bun run dev`, but it cannot exercise
Tauri commands or the local file-backed behavior.

Run the verification suite:

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

Optional development-only integration variables are documented in
[`.env.example`](.env.example). `.env.local` is ignored by Git. Prefer entering
credentials in Settings, which stores secrets in the operating-system
credential store.

## Architecture

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 / WKWebView |
| Frontend | React, Vite, TanStack Router and Query, Tiptap, Tailwind |
| Backend | Rust commands, parsers, atomic file writes, filesystem watcher |
| Primary storage | Markdown and YAML frontmatter in the selected vault |
| Derived storage | SQLite FTS5, normalized tag/wikilink edges, iCal JSON cache |

The SQLite index and calendar cache can be rebuilt. Deleting them does not
delete the vault. User-requested record deletion moves files into
`.woodshed/trash/` inside the vault so accidental deletion is recoverable.

## Privacy and network boundaries

Woodshed has no account system, analytics, crash reporter, or operated backend.
Configured integrations communicate directly from the desktop app:

- Gmail uses IMAP/SMTP. App Passwords are stored by the OS.
- Google Calendar uses a read-only secret iCal URL stored by the OS.
- Resource capture fetches the URL the user submits. Public fetches reject
  private and local network destinations, redirects are revalidated, and
  responses are size- and time-bounded.
- Remote images in email are stripped by default and fetched only after the
  user explicitly chooses to load them.
- Hermes receives selected content only after an explicit agent or Sweep
  action. Generated plans show a confirmation before creating records or
  archiving mail.
- Deepgram receives microphone audio or synthesis text only when voice features
  are explicitly invoked.

See [the privacy notice](docs/legal/PRIVACY.md) and
[security model](docs/SECURITY-MODEL.md) for details.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Please do
not report vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).
Maintainers preparing the first public repository should also follow the
[open-source release checklist](docs/OPEN_SOURCE_RELEASE.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
