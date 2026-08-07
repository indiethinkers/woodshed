# Plan 001: Mutation failure feedback

**Finding:** Mutations fail silently across Cadence, Mail, and scheduled integration refresh.  
**Written against:** `89a9120`  
**Effort:** M | **Risk:** Low

## Why this matters

Users perform optimistic UI updates (task reorder, archive, journal save) that roll back on backend failure with no toast, inline error, or retry affordance. Manual refresh in the title bar already surfaces partial failures via Sonner; scheduled refresh and Cadence/Mail mutations do not.

## Current state

### Cadence hooks — rollback only

```160:165:src/lib/hooks/use-tasks.ts
    onError: (_err, _vars, context) => {
      if (!context) return;
      for (const [key, value] of context.snapshots.entries()) {
        qc.setQueryData(key, value);
      }
    },
```

Same pattern in `use-daily-journal.ts`, `use-events.ts` — no user-visible signal.

### Mail — console.error only

```362:379:src/components/mail/email-detail.tsx
  const handleArchive = useCallback(() => {
    // ...
    for (const m of messages) {
      archiveOne(m.id).catch((e) => console.error("archive failed", e));
    }
    openAfterAction(nextId);
  }, [/* ... */]);

  const handleDelete = useCallback(() => {
    const nextId = nextEmailIdAfter();
    for (const m of messages) {
      deleteOne(m.id).catch((e) => console.error("delete failed", e));
    }
    openAfterAction(nextId);
  }, [/* ... */]);
```

Send/snooze already toast on success (`compose-dialog.tsx`, `snooze-button.tsx`, `inline-reply.tsx`).

### Scheduled refresh — silent allSettled

```57:68:src/components/layout/integration-refresh-scheduler.tsx
    const refresh = async () => {
      if (cancelled || running.current) return;
      running.current = true;
      lastStartedAt = Date.now();
      try {
        await Promise.allSettled([
          refreshCalendarRef.current(),
          refreshMailRef.current(),
        ]);
      } finally {
        running.current = false;
      }
    };
```

Manual refresh with toasts lives in `title-bar-actions.tsx` ~240–287.

### Existing toaster

```1:32:src/components/layout/toaster.tsx
import { Toaster as SonnerToaster } from "sonner";
// Mount once in providers; call toast(...) from anywhere via sonner.
```

## Conventions to follow

- Import `toast` from `sonner` (same as mail send and title-bar refresh).
- Never log vault contents, email subjects, or credential values in toast copy.
- Keep optimistic rollback behavior; add feedback without blocking navigation where UX already advances immediately (Mail archive/delete).
- Match existing toast tone: short title + optional `description`.

## Implementation steps

### 1. Add a small shared helper (recommended)

Create `src/lib/mutation-toast.ts` (or colocate in `src/lib/toast-errors.ts`):

```ts
import { toast } from "sonner";

export function toastMutationError(action: string, error: unknown) {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  toast.error(`Could not ${action}`, { description: message });
}
```

Keep messages generic (“Could not save task”, “Could not archive message”).

### 2. Cadence mutations

In `src/lib/hooks/use-tasks.ts`, `use-daily-journal.ts`, `use-events.ts`:

- In each mutation `onError`, after rollback, call `toastMutationError` with a surface-specific action label (`save task`, `create task`, `save journal`, `save event`, etc.).
- Do not toast on intentional user cancellation or validation errors already handled in UI.

**Verification:**

```sh
bun run test src/lib/hooks/use-tasks.test.tsx
bun run test src/lib/hooks/use-daily-journal.test.tsx
bun run test src/lib/hooks/use-events.test.tsx
```

Add or extend tests: mock `sonner`, trigger `onError`, assert `toast.error` called once.

### 3. Mail archive/delete/mark-read

In `src/components/mail/email-detail.tsx` and `src/components/mail/mail-inbox.tsx`:

- Replace bare `console.error` in `.catch()` with `toastMutationError`.
- For bulk thread archive/delete, one toast per failed action is enough (avoid N toasts for N messages).

In `useAutoMarkRead` (`email-detail.tsx` ~655): toast on mark-read failure is optional — default **off** to avoid spam while scrolling threads; only add if product wants it.

**Verification:**

```sh
bun run test src/components/mail/email-detail.test.tsx
bun run test src/components/mail/mail-inbox.test.tsx
```

### 4. Scheduled integration refresh

In `integration-refresh-scheduler.tsx`:

- Destructure `allSettled` results; on rejection, show **at most one** toast per refresh cycle (debounce: skip if an error toast fired in the last 5 minutes unless manual refresh also failed).
- Reuse failure message shaping from `title-bar-actions.tsx` (`errorMessage`, account failure counts) — extract shared helper if duplication exceeds ~15 lines.

**Verification:**

```sh
bun run test src/components/layout/integration-refresh-scheduler.test.tsx
```

Extend existing test file to assert toast on rejected refresh.

## Files in scope

- `src/lib/mutation-toast.ts` (new)
- `src/lib/hooks/use-tasks.ts`
- `src/lib/hooks/use-daily-journal.ts`
- `src/lib/hooks/use-events.ts`
- `src/components/mail/email-detail.tsx`
- `src/components/mail/mail-inbox.tsx`
- `src/components/layout/integration-refresh-scheduler.tsx`
- Optionally `src/components/layout/title-bar-actions.tsx` (extract shared refresh failure helper)
- Co-located `*.test.ts(x)` files

## Out of scope

- Success toasts for every Cadence save (autosave is silent by design)
- Rust command error message changes
- Settings UI for refresh interval

## Done criteria

- [ ] Cadence task/event/journal mutation failure shows Sonner error after rollback
- [ ] Mail archive/delete failure shows Sonner error (navigation may still advance)
- [ ] Scheduled refresh failure shows non-spammy Sonner error when calendar/mail refresh rejects
- [ ] `bun run lint` passes
- [ ] `bun run test` passes (new/updated tests included)
- [ ] No private vault/email data in toast strings

## Escape hatches

- If extracting refresh failure text from `title-bar-actions.tsx` causes a large refactor, duplicate minimal failure strings in the scheduler and leave a TODO to dedupe — do not block the plan.
- If `onError` fires during tests without Sonner mocked globally, add `vi.mock("sonner")` in affected test files only.

## Maintenance

Any new optimistic mutation should call `toastMutationError` in `onError`. Review Cadence/Mail hooks in PRs that add mutations.
