# Plan 006: Notebook index sidebar chrome

**Finding:** Notebook index sidebar leads with title/count instead of "New note".  
**Written against:** `89a9120`  
**Effort:** S | **Risk:** Low

## Why this matters

Index page sidebars (Resources, People, Areas, Databases) start with a full-width **New x** action. Notebook alone shows a "Notebook" title band + count pill above **New note**, breaking visual consistency (see maintainer screenshots).

## Current state

### Notebook — title first

```36:39:src/components/notebook/note-context-sidebar.tsx
  return (
    <ListSidebar title="Notebook" count={data?.length ?? 0}>
      <NewNoteAction />
      <ListSidebarSectionHeader label="Folders" count={folders.length} />
```

### Resources — action first, no title

```37:44:src/components/resources/resource-context-sidebar.tsx
  return (
    <ChronologicalSidebar
      items={items}
      isLoading={isLoading}
      emptyMessage="No resources yet. Save one above."
      action={<NewResourceControl />}
    />
```

### People — action first

```77:79:src/components/people/person-context-sidebar.tsx
  return (
    <ListSidebar>
      <NewPersonControl />
```

### ListSidebar API

```15:16:src/components/shared/list-sidebar.tsx
  /** Omit for surface-level sidebars whose page title already supplies context. */
  title?: string;
```

## Implementation steps

### 1. Remove title band from NotebookIndexSidebar

In `src/components/notebook/note-context-sidebar.tsx`:

Change:

```tsx
<ListSidebar title="Notebook" count={data?.length ?? 0}>
```

To:

```tsx
<ListSidebar>
```

Keep `<NewNoteAction />` as first child, then Folders, then Favorites — unchanged order below the action.

Do **not** migrate to `ChronologicalSidebar` (Notebook needs folder tree).

### 2. Verify padding matches siblings

`ListSidebar` without title uses `px-4 py-4` on content wrapper (~37). Confirm visual match with People/Areas sidebars after change.

### 3. Tests

Extend `src/components/shared/list-sidebar.test.tsx` or add `src/components/notebook/note-context-sidebar.test.tsx`:

```tsx
render(<NotebookIndexSidebar />);
expect(screen.queryByRole("heading", { level: 2, name: "Notebook" })).toBeNull();
expect(screen.getByRole("button", { name: "New note" })).toBeTruthy();
// "Folders" section header appears after New note in DOM order
```

Mock hooks: `useAllNotes`, `useSearch`, `useNavigate` — follow `person-context-sidebar.test.tsx` pattern.

**Verification:**

```sh
bun run test src/components/notebook/note-context-sidebar.test.tsx
bun run test src/components/shared/list-sidebar.test.tsx
bun run lint
```

## Files in scope

- `src/components/notebook/note-context-sidebar.tsx`
- New or extended test file under `src/components/notebook/`

## Out of scope

- Removing Folders or Favorites sections
- Changing main list panel (`note-list.tsx` RecordTable title "Notebook")
- Note count display elsewhere

## Done criteria

- [ ] Notebook index sidebar: **New note** is the first interactive row
- [ ] No h2 "Notebook" title band in list panel sidebar
- [ ] Folders and Favorites sections unchanged
- [ ] Test asserts heading absent and New note present
- [ ] `bun run lint && bun run test` pass

## Escape hatches

- If product wants count somewhere, add optional mono count on Folders header only — do not restore full title band.

## Maintenance

New index sidebars should omit `ListSidebar` `title` when the content panel already shows the surface name.
