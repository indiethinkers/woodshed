import { useEffect, useRef, useState } from "react";
import { useAreaMutations } from "@/lib/hooks/use-areas";
import type { Area } from "@/lib/types";

interface NewAreaFormProps {
  /** Called after the area is successfully created with the new Area. */
  onCreated: (area: Area) => void;
  /** Called when the user cancels the form (Esc, Back button). */
  onCancel: () => void;
  /** Optional eyebrow above the name input. Default: "New area". */
  label?: string;
  /** Compact mode tightens spacing for use inside dropdowns. */
  compact?: boolean;
}

/**
 * Inline form for creating a area. Used from:
 *   - the new-task picker ("+ New area" row in the task sidebar)
 *   - the task detail Area dropdown
 *   - the Areas sidebar list
 *
 * Renders a name input and Back/Create buttons. stopPropagation on every key
 * event so the global type-anywhere palette doesn't intercept input while the
 * form has focus.
 */
export function NewAreaForm({
  onCreated,
  onCancel,
  label = "New area",
  compact = false,
}: NewAreaFormProps) {
  const { create } = useAreaMutations();
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function commit() {
    if (!name.trim() || create.isPending) return;
    const created = await create.mutateAsync({ name: name.trim() });
    onCreated(created);
  }

  const sizing = compact
    ? { input: "h-7 text-[13px]", button: "h-6 px-2 text-[12px]" }
    : { input: "h-8 text-sm", button: "h-7 px-3 text-[13px]" };

  return (
    <div
      className="space-y-2 outline-none"
      onKeyDown={(e) => {
        // Global type-anywhere palette listens at the window — stopPropagation
        // keeps printable keys, Enter, and Escape from leaking up.
        if (e.key.length === 1 || e.key === "Enter" || e.key === "Escape") {
          e.stopPropagation();
        }
      }}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Area name"
        className={`w-full px-2 rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)] ${sizing.input}`}
      />
      <div className="flex items-center justify-end gap-1.5 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={create.isPending}
          className={`rounded-sm text-muted-foreground hover:text-foreground ${sizing.button}`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={create.isPending || !name.trim()}
          className={`rounded-sm bg-accent text-accent-foreground disabled:opacity-50 ${sizing.button}`}
        >
          {create.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
