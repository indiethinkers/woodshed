## What changed

<!-- Describe the user-visible outcome and the smallest important implementation detail. -->

## Why

<!-- Link the issue or explain the problem this solves. -->

Closes #

## Verification

<!-- List the exact automated checks and manual flows you ran. -->

- [ ] `bun run build`
- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] Relevant Rust checks from `CONTRIBUTING.md`

## Trust and data checklist

Mark items that apply, and explain any unchecked item in the PR description.

- [ ] Vault writes use the scoped helpers and preserve recoverability.
- [ ] Untrusted Markdown, HTML, mail, calendar, or model output is validated or sanitized at its boundary.
- [ ] New network access or permissions are explicit, narrow, and documented.
- [ ] Record schema, migration, privacy, and security documentation is updated where needed.
- [ ] No secrets, credentials, private vault content, or personal messages are included.

## Screenshots

<!-- For UI changes, add before/after images using synthetic data. Otherwise write "Not applicable." -->
