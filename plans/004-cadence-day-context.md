# Plan 004: Cadence day context and schedule UX

**Finding:** Event detail breaks sidebar day context; schedule expand sticks without collapse in sidebar variant.  
**Written against:** `89a9120`  
**Effort:** M | **Risk:** Med

## Why this matters

On `/cadence/event/...`, Tasks and Schedule fall back to **today** while the content panel shows another day's event. Sidebar schedule can expand and never collapse, eating task list space. Empty schedule copy always says "today".

## Current state

### extractDate — null on event routes

```1898:1905:src/components/cadence/task-sidebar.tsx
export function extractDate(pathname: string): string | null {
  const match = pathname.match(/^\/cadence\/([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  return match ? match[1] : null;
}
```

Event routes: `/cadence/event/$id`, `/cadence/event/ical/...` — no date segment → sidebar uses today.

### Schedule collapse — page only

```169:173:src/components/cadence/schedule-block.tsx
            {variant === "page" && (
              <CollapseToggle onCollapse={() => setCollapsedPreference(true)} />
            )}
```

Sidebar variant persists expanded state via `localStorage` (~44–52) with no collapse control.

### Empty copy

```190:190:src/components/cadence/schedule-block.tsx
      <p className="min-w-0 text-[13.5px] italic">No events scheduled today.</p>
```

### Escape commits titles (bundled small fix)

```497:501:src/components/cadence/task-editor.tsx
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            onCommit();
          }
        }}
```

Same in `event-detail.tsx`, `ical-event-detail.tsx` `TitleInput`.

## Implementation steps

### 1. Resolve sidebar day from open event

**Approach:** Extend day resolution beyond pathname regex.

- In `task-sidebar.tsx` (or a new `src/lib/cadence/sidebar-date.ts`), add `resolveSidebarDate(pathname, eventDate?: string | null): string`:
  - If `extractDate(pathname)` matches, use it.
  - Else if pathname matches event detail routes, use `eventDate` from loaded event/task context (pass from parent or read route loader data).
  - Else fall back to `useToday()`.

- Wire event detail routes to pass event's `date` field into sidebar consumers (`ScheduleBlock`, task list scope).

- Add unit tests:

```sh
bun run test src/components/cadence/task-sidebar.test.tsx
```

Test cases: `/cadence/2026-08-07`, `/cadence/event/abc` with event date `2026-08-05` → sidebar shows Aug 5.

### 2. Sidebar schedule collapse

In `schedule-block.tsx`:

- Show `CollapseToggle` for `variant === "sidebar"` when schedule is expanded (mirror page variant).
- Reuse `setCollapsedPreference(true)` and existing localStorage helpers.

**Verification:** Manual on Cadence with pinned sidebar — expand then collapse schedule.

### 3. Contextual empty schedule copy

In `NoEventsRow`, accept `date: string` prop; format:

- Today → "No events scheduled today."
- Other days → "No events scheduled for {weekday, month day}."

Pass resolved sidebar date from parent.

### 4. Escape cancels title edit (small)

In shared `TitleInput` (task-editor.tsx):

- Track draft on edit start.
- **Enter** → commit (unchanged).
- **Escape** → revert draft, blur, do not call `onCommit`.

Apply to event detail title inputs.

**Verification:**

```sh
bun run test src/components/cadence/task-editor.test.tsx  # add Escape test if file exists
```

## Files in scope

- `src/components/cadence/task-sidebar.tsx`
- `src/components/cadence/schedule-block.tsx`
- `src/components/cadence/task-editor.tsx`
- `src/components/cadence/event-detail.tsx`
- `src/components/cadence/ical-event-detail.tsx`
- Optional new `src/lib/cadence/sidebar-date.ts`
- Cadence route files if they must pass event date to layout
- Tests

## Out of scope

- Task scope semantics ("Today" vs "Week" vs "All") — separate UX copy effort
- Mandatory area pick on new task
- iCal sync behavior

## Done criteria

- [ ] Event detail page: sidebar Tasks/Schedule match event's date, not today
- [ ] Sidebar schedule can collapse after expand
- [ ] Empty schedule message uses viewed day, not always "today"
- [ ] Escape reverts inline title edit without saving
- [ ] `bun run lint && bun run test` pass

## Escape hatches

- If event date is unavailable while loading, show skeleton or today with subtle "Loading schedule…" — do not flash wrong day permanently.
- If route refactor is large, read event date from TanStack Query `useEvent(id)` inside sidebar when pathname matches event route.

## Maintenance

New Cadence deep links must participate in `resolveSidebarDate` or sidebar will drift again.
