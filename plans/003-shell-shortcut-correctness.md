# Plan 003: Shell shortcut correctness

**Finding:** Shell shortcuts conflict with labels, editors, and compose/thread Escape handling.  
**Written against:** `89a9120`  
**Effort:** S | **Risk:** Low

## Why this matters

Daily chrome friction: Plus button claims ⌘T opens a new tab but ⌘T opens the command palette in new-tab mode; ⌘/ toggles references while typing in Tiptap; Escape in compose can also exit the mail thread.

## Current state

### Plus vs ⌘T mismatch

```142:151:src/components/layout/title-bar.tsx
        <button
          onClick={newTab}
          title="New tab (⌘T)"
          aria-label="New tab"
```

```117:126:src/components/shared/command-palette.tsx
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setMode("new-tab");
        setOpen(true);
        return;
      }
```

`newTab()` in `tabs-context.tsx` ~279–304 appends a Cadence tab — only the Plus button calls it.

### ⌘/ without editable guard

```71:80:src/components/layout/right-sidebar-context.tsx
    function onKeyDown(event: KeyboardEvent) {
      if (!isRightSidebarToggleShortcut(event)) return;
      event.preventDefault();
      setOpen((current) => !current);
    }
```

Contrast `title-bar.tsx` ~57–61: ⌘B skips when `isEditableElement(event.target)`.

### Compose Esc + thread Esc

Both register on `window` without compose taking priority when focus is on non-editable compose chrome (`compose-dialog.tsx` ~267–281, `email-detail.tsx` ~382–395).

## Conventions to follow

- Reuse `isEditableElement` from `@/lib/dom/is-editable`.
- Shortcut helpers live in dedicated modules where they exist (`list-panel-shortcut.test.ts` pattern).
- Tooltips use `title` or existing kbd chip components in sidebar/title-bar.

## Implementation steps

### 1. Fix Plus button label

In `title-bar.tsx`:

- Change Plus `title` / `aria-label` to **"New tab"** without ⌘T, **or** document actual shortcut if one is added later.
- Do **not** change ⌘T palette behavior (intentional per audit).

**Verification:** Manual — Plus tooltip no longer claims ⌘T.

### 2. Guard ⌘/ in editors

In `right-sidebar-context.tsx`:

```ts
import { isEditableElement } from "@/lib/dom/is-editable";

function onKeyDown(event: KeyboardEvent) {
  if (!isRightSidebarToggleShortcut(event)) return;
  if (isEditableElement(event.target)) return;
  event.preventDefault();
  setOpen((current) => !current);
}
```

**Verification:**

```sh
bun run test src/components/layout/right-sidebar-shortcut.test.ts  # extend or add
```

### 3. Compose Escape priority

Choose one approach (implement **A**):

**A (preferred):** In `email-detail.tsx` Escape handler, return early when compose dialog is open. Export a tiny module-level flag or read from React context if compose sets `data-compose-open` on `document.body`.

**B:** In `compose-dialog.tsx`, register Escape with `{ capture: true }` and `stopImmediatePropagation()` when `open`.

Ensure: Esc with compose focused closes compose only; second Esc exits thread.

**Verification:**

```sh
bun run test src/components/mail/compose-dialog.test.tsx
bun run test src/components/mail/email-detail.test.tsx
```

Add test: compose open + Esc does not call `navigate` to `/mail`.

### 4. (Optional, same PR if trivial) Focus-visible on shell icon buttons

Add `focus-visible:ring-2 focus-visible:ring-foreground/15` to title-bar/sidebar icon buttons missing it — match `ui/button.tsx`.

## Files in scope

- `src/components/layout/title-bar.tsx`
- `src/components/layout/right-sidebar-context.tsx`
- `src/components/mail/compose-dialog.tsx`
- `src/components/mail/email-detail.tsx`
- Tests listed above

## Out of scope

- Command palette focus trap (separate a11y effort)
- Tab strip Arrow key navigation
- Changing ⌘T palette semantics

## Done criteria

- [ ] Plus button does not claim ⌘T
- [ ] ⌘/ does not toggle references when typing in editable fields
- [ ] Esc closes compose without leaving thread on first press
- [ ] `bun run lint && bun run test` pass

## Escape hatches

- If compose-open detection is awkward, use `document.querySelector('[data-compose-dialog-open]')` attribute set by compose portal — minimal coupling.

## Maintenance

Any new global `keydown` listener in layout must check `isEditableElement` when appropriate.
