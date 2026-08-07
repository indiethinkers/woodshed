# Woodshed UX improvement plans

Advisory plans written from a standard-effort UX audit. Each file is self-contained for an executor with no prior session context.

**Written against:** `89a9120`  
**Branch for plans only:** `cursor/ux-improve-plans-a13c`  
**Default selection:** Top 7 findings by leverage, plus maintainer requests (#6 Notebook sidebar, #7 typing stability).

## Status

| Plan | Finding | Status | Notes |
|------|---------|--------|-------|
| [001-mutation-feedback.md](./001-mutation-feedback.md) | Silent mutation failures | TODO | |
| [002-destructive-action-safety.md](./002-destructive-action-safety.md) | Unsafe/misleading deletes | TODO | Depends lightly on 001 toast patterns |
| [003-shell-shortcut-correctness.md](./003-shell-shortcut-correctness.md) | Shell shortcut conflicts | TODO | |
| [004-cadence-day-context.md](./004-cadence-day-context.md) | Cadence day context + schedule | TODO | |
| [005-honest-empty-error-states.md](./005-honest-empty-error-states.md) | Empty/error state honesty | TODO | |
| [006-notebook-index-sidebar-chrome.md](./006-notebook-index-sidebar-chrome.md) | Notebook sidebar chrome | TODO | |
| [007-editor-typing-stability.md](./007-editor-typing-stability.md) | Editor typing jank | TODO | |

## Recommended execution order

```text
001 → 002        (toast helper first; destructive actions reuse it)
003              (independent shell fixes)
004              (Cadence; can parallel with 003)
005              (empty/error states; independent)
006              (Notebook sidebar; small, independent)
007              (editor typing; independent)
```

**Parallelizable:** 003, 004, 005, 006, 007 can run in parallel after 001 lands if multiple executors are available. 002 should follow 001.

## Verification baseline (all plans)

From `<repo_root>`:

```sh
bun install --frozen-lockfile
bun run build          # generates route tree for typecheck
bun run lint
bun run typecheck
bun run test           # focused tests per plan, then full suite before handoff
```

Linux cloud caveat: two macOS-only PDFKit tests in `commands::agent` fail on Linux; expected.

## Direction backlog (not planned)

- Unify create flows across list surfaces
- Editor slash / wikilink / embed discoverability
- Areas delete UI (`area_delete` exists in hooks)
- Onboarding email optionalization
- Agent “needs setup” CTA for managed Hermes
- Graph filtered-empty + search
- Escape-to-cancel on inline title edits (finding #8)
- Mail/table keyboard consistency (finding #12)
- Full tablist ARIA keyboard navigation

## Considered and rejected

| Item | Reason |
|------|--------|
| ⌘T opening command palette in new-tab mode | Intentional Chrome-like behavior; only Plus tooltip is wrong |
| Mark-all-unread-on-thread-open | Partially Gmail-like product direction |
| Full tablist ARIA keyboard | Lower leverage than shortcut correctness |
| Removing Notebook Folders/Favorites | Out of scope; only chrome order changes |
| Early TipTap curly quotes | Maintainer prefers straight quotes + OS suppression |
| Rewriting existing vault curly quotes | Stored `'` in files stays as-is |
