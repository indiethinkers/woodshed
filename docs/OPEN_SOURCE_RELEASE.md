# Open-source release checklist

This checklist covers publishing the first public Woodshed repository. It is
separate from the normal release workflow because making a private repository
public exposes its complete Git history, not just the current files.

## Publish a clean history

Do **not** make the existing private repository public. Its early history
contains approximately 42,000 generated `node_modules/` files. Although those
files have since been removed and no credential was found in the audited
history, publishing that history would permanently distribute unnecessary
third-party source and make the repository needlessly large.

Create the public repository from an audited snapshot of the release commit:

1. Finish and sign off the release commit in the private repository.
2. Export only that commit's tracked files (for example, with `git archive`).
3. Inspect the export before initializing a new Git repository around it.
4. Create the public repository with that snapshot as its initial commit.
5. Keep the existing private repository private if its detailed history is
   still useful; do not force-push a rewritten history over it.

This intentionally changes the public commit identity. Record the private
source commit in internal release notes if provenance needs to be retained.

## Inspect the publication candidate

- Run a full secret scanner over the exported tree before committing it. Do
  not rely on `.gitignore` as a credential control.
- Confirm the export contains no `.env*` file except `.env.example`, signing
  key, app data, user vault, mail, calendar cache, logs, or database files.
- Confirm no documentation, fixture, screenshot, or test contains private
  names, messages, calendar events, physical addresses, URLs with embedded
  credentials, or access tokens. The approved maintainer name and public
  contact email in legal/security notices are intentional.
- Review `git ls-files` in the new repository; generated dependencies and build
  products must be absent.
- Verify `LICENSE`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, the privacy
  notice, and the security model match the release.

## Verify the snapshot

Run from a fresh checkout of the public candidate:

```sh
bun install --frozen-lockfile
bun audit
bun run build
bun run lint
bun run typecheck
bun run test
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo audit --file src-tauri/Cargo.lock
```

Exercise onboarding against a temporary synthetic vault. Test every configured
integration with non-production credentials, then remove those credentials and
the generated app-data directory before preserving any test artifact.

## Configure the public repository

- Enable private vulnerability reporting and dependency alerts.
- Enable Dependabot security updates and the checked-in update configuration.
- Protect `main`: require pull requests, CI, review, and resolution of review
  threads; restrict force pushes and deletion.
- Keep workflow permissions read-only by default. Grant release write access
  only to the release job.
- Store Apple signing, notarization, and Tauri updater keys only as encrypted
  repository or environment secrets. Require environment approval for
  production releases.
- Require signed release artifacts and publish checksums with each release.
- Configure the repository's security contact and verify the private reporting
  path described in `SECURITY.md` works.

## Final manual review

Before announcing the repository, have a maintainer who did not implement the
hardening review the exact public commit and its generated artifacts. Re-run
the secret scan and dependency audits against that commit, verify the
downloaded release signature, and perform an install on a clean macOS account.
