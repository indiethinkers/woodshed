# Contributing to Woodshed

Thanks for helping improve Woodshed. The project handles private local files,
email, credentials, and outbound integrations, so changes at trust boundaries
need tests and a clear explanation.

## Before you start

For substantial features or architectural changes, open an issue first. For a
security vulnerability, use the private process in [SECURITY.md](SECURITY.md)
instead of an issue.

By submitting a contribution, you agree that it is licensed under Apache-2.0,
as described in section 5 of the project license.

## Development workflow

1. Install the prerequisites and dependencies documented in [README.md](README.md).
2. Create a focused branch and keep unrelated changes out of the pull request.
3. Add or update tests before changing behavior.
4. Run the complete verification commands from the README.
5. Explain user-visible behavior, data migrations, security implications, and
   manual verification in the pull request.

Use Bun for JavaScript commands. Do not commit `.env.local`, vault contents,
email fixtures containing real messages, credentials, generated `dist/`, or
`src-tauri/target/` artifacts.

## Security expectations

- Treat vault files, email, calendar feeds, fetched HTML, and model output as
  untrusted input.
- Resolve vault paths through the helpers in `src-tauri/src/vault/mod.rs`.
- Use the bounded record reader for vault text and never follow symlinked
  collection entries.
- Do not expose generic shell or filesystem permissions to the webview.
- Route public URL fetches through `src-tauri/src/network.rs` and set explicit
  time, redirect, and response-size limits.
- Store secrets in the operating-system credential store; configuration files
  may contain only non-secret metadata and migration-only deserialization fields.
- Sanitize HTML at the boundary and keep remote email images opt-in.
- Preserve recoverability for destructive operations.

## Pull request checklist

- [ ] Tests cover success, malformed input, and relevant boundary cases.
- [ ] `bun run build`, lint, typecheck, and tests pass.
- [ ] Rust format, Clippy, tests, and dependency audits pass.
- [ ] New Tauri commands are narrowly scoped and included only if needed.
- [ ] Documentation and privacy disclosures match actual behavior.
- [ ] No secrets or personal vault data are included.
