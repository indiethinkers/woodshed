# site/ — Woodshed marketing site

Plain static HTML/CSS. Three pages:

- `/` — landing page (`index.html`)
- `/privacy` — privacy policy (`privacy.html`)
- `/terms` — terms of service (`terms.html`)

The clean URLs (no `.html`) work via `_redirects` (Cloudflare Pages,
Netlify) and `vercel.json` (Vercel).

## Before you publish

Keep `privacy.html` and `terms.html` synchronized with their Markdown source
files whenever storage, network integrations, licensing, or contact details
change. Confirm every published email address routes to a monitored inbox.

## Deploy: Cloudflare Pages (recommended)

Cloudflare Pages is free, fast, and gives you a verified domain in
~5 minutes. The path that touches the fewest moving parts:

1. Push this repo to GitHub.
2. Sign in to https://dash.cloudflare.com/ → Pages → **Create a project** → **Connect to Git**.
3. Select the repo. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave blank)*
   - **Build output directory:** `site`
4. Hit Deploy. You get a `*.pages.dev` URL.
5. Add custom domain (e.g., `woodshed.md`):
   Pages project → **Custom domains** → **Set up a custom domain**.
   Cloudflare auto-provisions SSL.
6. Verify in Google Search Console using the DNS TXT record method.
7. Confirm `/privacy` and `/terms` resolve cleanly (Cloudflare honors
   the `_redirects` file automatically).

Cost: $0 for this scope.

## Deploy: Vercel

1. Push this repo to GitHub.
2. https://vercel.com/new → import the repo.
3. **Root Directory:** `site`. Framework preset: Other.
4. Deploy. Add custom domain in the project settings.

Vercel reads `vercel.json` for clean URLs and security headers.

## Deploy: Netlify, GitHub Pages, anywhere else

Drop the contents of `site/` into the static-site root. The
`_redirects` file works on Netlify out of the box. On GitHub Pages,
clean URLs `/privacy` and `/terms` work because the default Jekyll
config maps them — but only if you keep the `.html` files at root.

## Local preview

```sh
cd site
python3 -m http.server 8000
# open http://localhost:8000/
```

Or:

```sh
bunx serve site --listen 8000
```

## Typography

The marketing page uses Iowan Old Style/Baskerville for editorial display type
and Avenir Next/Helvetica Neue for interface copy. They are system stacks, so
the static site makes no third-party font requests. Document pages share the
same typography.

Do not replace these with a generic hosted web font without revisiting the
overall art direction. The contrast between field-guide editorial type and the
precise product UI is intentional.

## GitHub repository metadata

Repository sidebar settings are not version-controlled. After merging a change
to the public product story, keep the GitHub settings aligned with the metadata
in `package.json`:

- **Description:** A macOS workspace connecting calendar, inbox, notes, tasks,
  and people in local Markdown.
- **Website:** https://woodshed.md

## Logo

The favicon and brand mark are placeholder inline SVG (rounded
square with three horizontal lines, riffing on the markdown
metaphor). Replace them with the real Woodshed logo before public
release. The same source PNG flows through:

- `site/index.html` favicon
- `site/privacy.html` favicon
- `site/terms.html` favicon
- `assets/logo-1024.png` for `cargo tauri icon`
- public integration documentation and release assets

Keep them consistent. Reviewers cross-check.
