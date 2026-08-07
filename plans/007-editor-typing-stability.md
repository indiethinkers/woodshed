# Plan 007: Editor typing stability

**Finding:** Typing feels janky — apostrophe glyph swaps; Notebook paragraphs reflow oddly.  
**Written against:** `89a9120`  
**Effort:** M | **Risk:** Med

## Why this matters

Every prose surface uses shared TipTap (`tiptap-editor-impl.tsx`). Smart-quote input rules replace `'` with `'` on each keystroke, visibly changing the glyph. Notebook paragraph wrap may jump when scrollbar appears or punctuation metrics change.

## Current state

### Typography — smart quotes enabled by default

```674:700:src/components/shared/tiptap-editor-impl.tsx
      Typography.configure({
        leftArrow: false,
        rightArrow: false,
        // ... many false ...
        superscriptThree: false,
      }),
```

Comment explains early curly quotes vs late macOS swap. Default options leave `openSingleQuote`, `closeSingleQuote`, `openDoubleQuote`, `closeDoubleQuote`, `emDash`, `ellipsis` **enabled**.

TipTap rule (`@tiptap/extension-typography`):

```209:213
export const closeSingleQuote = (override?: string) =>
  textInputRule({
    find: /'$/,
    replace: override ?? ''',
  })
```

Every typed apostrophe becomes U+2019 immediately.

### No editor autocorrect attrs

`editorProps.attributes` (~804–817) sets class and data attrs only — no `autocorrect`, `autocomplete`, `spellcheck`.

### Content scroll — no stable gutter

```222:232:src/components/layout/content-panel.tsx
        <ScrollArea
          viewportProps={{
            ...({ "data-woodshed-content-scroll": "" } as Record<...>),
            ref: viewportRef,
          }}
        >
```

No `scrollbar-gutter: stable` on viewport — scrollbar appearance can narrow content mid-typing.

### Notebook editor

```198:204:src/components/notebook/note-detail.tsx
      <div className="mt-8 max-w-prose">
        <TiptapEditor
          className="text-base leading-normal min-h-[120px]"
```

## Implementation steps

### 1. Disable smart quote Typography rules

In `tiptap-editor-impl.tsx`, extend `Typography.configure`:

```ts
Typography.configure({
  openSingleQuote: false,
  closeSingleQuote: false,
  openDoubleQuote: false,
  closeDoubleQuote: false,
  emDash: false,      // disable in same pass — also causes mid-line metric jump on --
  ellipsis: false,    // disable ... → … for same reason
  leftArrow: false,
  // ... keep existing false flags ...
}),
```

Replace comment block (~674–682) with:

> Straight quotes stay as typed. Editor attrs suppress macOS smart substitution; we do not convert punctuation at keystroke time.

**Product note:** Em dash / ellipsis disabled with quotes — user can type `--` and `...` literally. Re-enable individually only if product requests.

### 2. Suppress OS smart substitution

In `editorProps.attributes`, add:

```ts
autocorrect: "off",
autocomplete: "off",
spellcheck: "false",  // or "true" if product wants red squiggles — default off for stability
```

Apply to `.tiptap-content` contenteditable element.

### 3. Stable scrollbar gutter

Add CSS for content scroll viewport. In `src/styles.css` (or Tailwind arbitrary variant on ScrollArea viewport if supported):

```css
[data-woodshed-content-scroll] {
  scrollbar-gutter: stable;
}
```

If Base UI ScrollArea viewport doesn't receive the attribute on the scrolling element, inspect DOM in devtools and apply rule to the element that actually scrolls (may need `viewportProps.className`).

**Verification:** Manual on Notebook — type until content scrolls; text should not shift horizontally when scrollbar appears.

### 4. Tests

**Typography / apostrophe:**

Add `src/components/shared/tiptap-editor-typing.test.tsx`:

- Mount `TiptapEditor` with test content.
- Simulate typing `'` via editor commands or `insertContent`.
- Assert document text contains U+0027 (`'`), not U+2019 (`'`).

Follow patterns in `tiptap-editor-caret.test.tsx` for editor mount/teardown.

**Optional CSS test:** If purely CSS, document manual verification in PR; no unit test required.

**Verification:**

```sh
bun run test src/components/shared/tiptap-editor-typing.test.tsx
bun run test src/components/shared/tiptap-editor-caret.test.tsx
bun run lint
```

### 5. Manual acceptance

On Notebook long paragraph:

1. Type several lines until wrap occurs — no horizontal jump on wrap changes.
2. Type `don't` — apostrophe stays straight ASCII throughout.
3. Repeat in Cadence journal and Agent if time permits (same editor).

## Files in scope

- `src/components/shared/tiptap-editor-impl.tsx`
- `src/styles.css` (scrollbar-gutter)
- Optionally `src/components/layout/content-panel.tsx` (viewport className)
- `src/components/shared/tiptap-editor-typing.test.tsx` (new)

## Out of scope

- Font stack change (Inter → Söhne)
- Rewriting existing vault files that already contain curly quotes
- Disabling Typography in read-only Markdown renderer
- Compact caret overlay changes (`tiptap-compact-caret`)

## Done criteria

- [ ] Typed `'` and `"` remain straight quotes in editor
- [ ] `--` does not auto-convert to em dash (with emDash: false)
- [ ] Editor has autocorrect/autocomplete off
- [ ] Content scroll uses stable scrollbar gutter (or documented alternative fix if gutter insufficient)
- [ ] New test passes for apostrophe
- [ ] `bun run lint && bun run test` pass

## Escape hatches

- If `scrollbar-gutter: stable` has no effect on WebKitGTK Linux VM, try `overflow-y: scroll` on viewport as fallback (always show scrollbar track) — document platform difference in PR.
- If macOS WKWebView still smart-quotes after attrs, research `-webkit-text-settings` or `inputmode` — stop and report if attrs alone fail on macOS; do not ship Linux-only fix without noting macOS gap.

## Maintenance

Do not re-enable Typography quote rules without UX review. Any new contenteditable should inherit the same DOM attrs.
