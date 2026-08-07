# Plan 005: Honest empty and error states

**Finding:** Empty/error states lie or blank out (references pane, list panels, Areas defaults).  
**Written against:** `89a9120`  
**Effort:** S–M | **Risk:** Low

## Why this matters

Failed loads look like empty vaults and invite duplicate creates. References pane looks broken when empty. Areas shows branded sample data when live query fails.

## Current state

### References — blank empty

```150:152:src/components/layout/right-sidebar-panel.tsx
        {entries.length === 0 ? (
          <div aria-hidden className="h-full" />
        ) : (
```

Shift+click to add pages is global (`right-sidebar-context.tsx` ~83–107) but undocumented in UI.

### Notebook — good error pattern

```129:147:src/components/notebook/note-list.tsx
      errorState={
        isError && notes.length === 0 ? (
          <>
            <p className="max-w-sm text-sm text-muted-foreground">
              Couldn&apos;t load your notes. Your files are safe on disk...
            </p>
            <button onClick={() => void refetch()}>Retry</button>
          </>
        ) : undefined
      }
```

People, Resources, Databases lists omit `errorState` on `RecordTable`.

### Areas — fake defaults

```58:58:src/components/areas/areas-list.tsx
  const areas = liveAreas ?? defaultAreas;
```

`defaultAreas` in `src/lib/areas.ts` ~21–27 includes branded sample names.

## Conventions to follow

- Empty copy: short, actionable, muted foreground — see `ListSidebarEmpty`, `ChronologicalSidebar` empty messages.
- Error copy: reassure files are on disk; offer Retry — mirror Notebook.
- Never show `defaultAreas` as live data when query failed or returned empty due to error.

## Implementation steps

### 1. References empty state

In `right-sidebar-panel.tsx`, replace blank `aria-hidden` div with:

```tsx
<div className="px-4 py-6 text-[13px] leading-relaxed text-muted-foreground">
  <p>Pin supporting pages here while you work.</p>
  <p className="mt-2">
    Shift-click any link to add it, or use the + button above.
  </p>
</div>
```

Remove `aria-hidden` from empty state (content is meaningful).

**Verification:** Manual — open references pane with no entries.

### 2. Port Notebook errorState pattern

For each list, add `isError`, `refetch` from query hook and pass `errorState` to `RecordTable` when `isError && rows.length === 0`:

| File | Hook |
|------|------|
| `src/components/people/people-list.tsx` | `useAllPeople` |
| `src/components/resources/clipping-list.tsx` | `useAllResources` |
| `src/components/tables/databases-list.tsx` | `useAllTables` / tags hook |

Copy template from Notebook; adjust surface name ("people", "resources", "databases").

**Verification:**

```sh
bun run test src/components/people/person-context-sidebar.test.tsx
bun run test src/components/tables/databases-list.test.tsx
```

Add render tests asserting Retry button when query errors.

### 3. Areas — stop misleading defaults

In `areas-list.tsx` and `areas-sidebar.tsx`:

- Use `liveAreas ?? []` when `isError` or when hook explicitly failed.
- Only use `defaultAreas` for **dev/demo** if documented — prefer empty state: "No areas yet" + create affordance.
- In `use-areas.ts`, stop returning `defaultAreas` on null Tauri response; return `[]` and let UI show empty/error.

**Verification:**

```sh
bun run test src/components/areas/areas-list.test.tsx
```

Test: when query errors, no "Woodshed" / "Indie Thinkers" sample names appear.

### 4. Areas list errorState (if using RecordTable pattern)

If Areas index uses custom list not `RecordTable`, add inline error UI matching Notebook retry pattern in `areas-list.tsx`.

## Files in scope

- `src/components/layout/right-sidebar-panel.tsx`
- `src/components/notebook/note-list.tsx` (reference only)
- `src/components/people/people-list.tsx`
- `src/components/resources/clipping-list.tsx`
- `src/components/tables/databases-list.tsx`
- `src/components/areas/areas-list.tsx`
- `src/components/areas/areas-sidebar.tsx`
- `src/lib/hooks/use-areas.ts`
- Tests

## Out of scope

- Onboarding empty states
- Graph empty state (direction backlog)
- Agent chat empty state

## Done criteria

- [ ] References pane shows helpful empty copy (Shift+click documented)
- [ ] People/Resources/Databases show Retry on load failure with empty cache
- [ ] Areas never shows `defaultAreas` names on error or failed load
- [ ] `bun run lint && bun run test` pass

## Escape hatches

- If `RecordTable` lacks `errorState` prop on a surface, add prop to shared component — it's already on Notebook's usage.

## Maintenance

New list surfaces using TanStack Query should pass `errorState` when `isError && !cachedData`.
