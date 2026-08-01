# Releasing Woodshed

Woodshed distributes signed, notarized macOS installers through GitHub
Releases. Each release build also remains available as a GitHub Actions
workflow artifact for maintainers.

GitHub Packages is intentionally not used for desktop installers. It is a
registry for package ecosystems and container images; downloadable application
builds belong in a GitHub Release. This follows the same public distribution
shape as Logseq: users download platform installers from release assets.

- [GitHub Releases documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [GitHub Packages documentation](https://docs.github.com/en/packages/learn-github-packages/introduction-to-github-packages)
- [Tauri GitHub Actions guide](https://v2.tauri.app/distribute/pipelines/github/)

## One-time repository setup

Add these Actions secrets under **Settings → Secrets and variables → Actions**:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

The release workflow validates that all six names are configured without
printing their values. See Tauri's
[macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) for how to
create the certificate and notarization credentials.

## Prepare a release

1. Update the version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`.
2. Move the relevant notes from `Unreleased` into a matching version section in
   `CHANGELOG.md`.
3. Validate the metadata from `<repo_root>`:

   ```sh
   bun run release:check -- vX.Y.Z
   ```

4. Merge the release commit to `main`, then create and push an annotated tag:

   ```sh
   git tag -a vX.Y.Z -m "Woodshed vX.Y.Z"
   git push origin vX.Y.Z
   ```

The tag starts `.github/workflows/release.yml`. It checks out the tagged commit,
audits dependencies, and builds separate Apple Silicon and Intel `.dmg` files.
The workflow creates a draft GitHub Release with generated notes and uploads
the installers both as release assets and workflow artifacts.

## Publish or retry

Install both draft assets on the matching Mac architectures before publishing
the release. A failed or interrupted build can be retried from **Actions →
Release (Tauri) → Run workflow** by supplying the existing tag. The workflow
checks out that tag explicitly, so a manual run cannot accidentally package a
different branch.
