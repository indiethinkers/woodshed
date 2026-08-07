# Plan 002: Destructive action safety

**Finding:** Destructive actions are unsafe or misleading (Mail Delete, table keyboard delete, compose Discard).  
**Written against:** `89a9120`  
**Effort:** M | **Risk:** Med  
**Depends on:** [001-mutation-feedback.md](./001-mutation-feedback.md) lightly (reuse toast helper for failed deletes)

## Why this matters

Mail **Delete** removes local vault files (`.woodshed/trash/`) and only marks Gmail `\Seen` — it does not trash remotely. One click with no confirmation. Database table rows delete instantly on Delete/Backspace while the bulk bar requires confirmation. Compose **Discard** deletes drafts without the autosave path Esc uses.

## Current state

### Mail Delete — no confirm, misleading label

```374:380:src/components/mail/email-detail.tsx
  const handleDelete = useCallback(() => {
    const nextId = nextEmailIdAfter();
    for (const m of messages) {
      deleteOne(m.id).catch((e) => console.error("delete failed", e));
    }
    openAfterAction(nextId);
  }, [messages, deleteOne, nextEmailIdAfter, openAfterAction]);
```

Backend (`src-tauri/src/commands/mail.rs` ~1863–1906): local trash + optional Gmail mark-seen only.

### Table keyboard delete — no confirm

```150:175:src/components/tables/table-view.tsx
  const bulkDeleteSelected = useCallback(() => {
    const ids = Array.from(selectedRowIds);
    Promise.all(ids.map((rowId) => removeRow.mutateAsync({ rowId }))).catch(/* rollback only */);
    setSelectedRowIds(new Set());
  }, [removeRow, selectedRowIds]);

  useEffect(() => {
    function deleteSelectedRows(event: KeyboardEvent) {
      if (!isTableRowDeleteShortcut(event) || selectedRowIds.size === 0 || isEditableElement(event.target)) return;
      event.preventDefault();
      bulkDeleteSelected();
    }
    // ...
  }, [bulkDeleteSelected, selectedRowIds.size]);
```

Button path uses `AlertDialog` at ~1707–1744. `record-table.tsx` uses `AlertDialog` for Notebook bulk delete (~364–397).

### Compose Discard — immediate, no confirm

```357:368:src/components/mail/compose-dialog.tsx
  async function handleDiscard() {
    await autosaveChainRef.current.catch(/* console.error */);
    const currentDraftId = draftIdRef.current;
    if (currentDraftId) {
      await deleteDraft(currentDraftId).catch(/* console.error */);
    }
    onClose();
  }
```

Esc calls `handleClose` which autosaves when content exists (~249–264).

## Conventions to follow

- Use existing `AlertDialog` from `@/components/ui/alert-dialog` (see `record-table.tsx`, `table-view.tsx` button path).
- Destructive confirm buttons: `variant` destructive styling already used elsewhere.
- Accurate copy: “Remove locally” not “Delete from Gmail”.
- After 001: use `toastMutationError` on failed delete/archive.

## Implementation steps

### 1. Mail Delete confirmation

In `email-detail.tsx`:

- Add state `deleteConfirmOpen`.
- Wire Delete button to open `AlertDialog` instead of calling `handleDelete` directly.
- Dialog copy (example):

  **Title:** Remove from Woodshed?  
  **Body:** This removes the message from your vault (recoverable in trash). Gmail is not updated — the message may still exist in your inbox online.  
  **Confirm:** Remove locally

- On confirm, run existing `handleDelete` logic.
- Apply same pattern to keyboard shortcut `#` / Delete if bound in thread view (grep `email-detail.tsx` for delete shortcut).

**Verification:**

```sh
bun run test src/components/mail/email-detail.test.tsx
```

Add test: Delete opens dialog; confirm invokes delete mutation mock.

### 2. Table keyboard delete → confirm dialog

In `table-view.tsx`:

- Refactor so both keyboard shortcut and bulk Delete button call `requestBulkDelete()` which sets `pendingDeleteIds` and opens the existing confirm dialog (or a shared `AlertDialog`).
- Do **not** call `bulkDeleteSelected` directly from keyboard handler until confirmed.

**Verification:**

```sh
bun run test src/components/tables/table-view.test.tsx  # create if missing minimal test
```

### 3. Compose Discard alignment

In `compose-dialog.tsx`:

- If `hasContent` (same check as `handleClose`), show confirm: “Discard draft?” with options **Keep editing** / **Discard**.
- On discard confirm: run current `handleDiscard` (delete draft file, close).
- **Discard button** and **Esc** should behave consistently: Esc with content autosaves (unchanged); explicit Discard with content confirms.

Inline reply (`inline-reply.tsx`): align Discard button with Esc confirm when non-empty (~68–74, ~114–122).

**Verification:**

```sh
bun run test src/components/mail/compose-dialog.test.tsx
```

## Files in scope

- `src/components/mail/email-detail.tsx`
- `src/components/mail/compose-dialog.tsx`
- `src/components/mail/inline-reply.tsx`
- `src/components/tables/table-view.tsx`
- Co-located tests

## Out of scope

- Changing Rust `mail_delete_one` semantics
- Gmail remote trash (not supported today)
- Undo toast with restore (nice-to-have; not required)

## Done criteria

- [ ] Mail Delete requires confirmation with accurate local-only copy
- [ ] Table Delete/Backspace requires same confirmation as bulk Delete button
- [ ] Compose Discard confirms when draft has content; Esc autosave unchanged
- [ ] Failed deletes show toast (from 001)
- [ ] `bun run lint && bun run test` pass

## Escape hatches

- If Mail delete shortcut is not wired, skip keyboard path and document in PR — button confirm is mandatory.
- If `table-view.tsx` confirm dialog is deeply coupled to selection UI, extract `BulkDeleteConfirmDialog` component rather than duplicating.

## Maintenance

New destructive actions on Mail/tables should use `AlertDialog` + accurate remote/local copy. Review trust-boundary changes against `docs/SECURITY-MODEL.md`.
