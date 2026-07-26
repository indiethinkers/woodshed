import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  FileText,
  User,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { useSearch, type SearchHit } from "@/lib/hooks/use-search";
import { useNoteMutations } from "@/lib/hooks/use-notes";
import { usePeopleMutations } from "@/lib/hooks/use-people";
import { useAreas } from "@/lib/hooks/use-areas";
import { addWikilinkTarget } from "@/lib/wikilinks";
import type { WikilinkPickerSelection } from "./extensions/wikilink-suggestion";
import type { WikilinkType } from "./extensions/wikilink";

export interface WikilinkPickerState {
  query: string;
  command: (selection: WikilinkPickerSelection) => void;
  clientRect: (() => DOMRect | null) | null;
}

export interface WikilinkPickerHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface Props {
  state: WikilinkPickerState;
}

interface Row {
  key: string;
  label: string;
  detail?: string;
  icon: LucideIcon;
  selection: WikilinkPickerSelection;
}

const KIND_ICON: Record<string, LucideIcon> = {
  note: FileText,
  person: User,
  event: FileText,
  resource: FileText,
  task: FileText,
  area: FileText,
};

// Only types we can create with sensible defaults at picker time.
// Event needs a date, resource needs a URL — both deferred until the
// picker grows a richer create dialog.
const CREATE_OPTIONS: Array<{ type: WikilinkType; label: string; icon: LucideIcon }> = [
  { type: "note", label: "Create note", icon: FileText },
  { type: "person", label: "Create person", icon: User },
];

/**
 * Wikilink page-picker. Mirrors `SlashCommandMenu` — portal popup anchored
 * to the caret, keyboard-navigated, dismissed on Escape.
 *
 * Two row groups:
 *   - **Existing** — FTS5 hits for the typed query, across all wikilink-able
 *     types (notes, people, events, resources, tasks, areas)
 *   - **Create** — only shown when the user has typed something. One row per
 *     possible target type. Selecting one eagerly creates the file (via
 *     `person_create` / `note_create`) and inserts a wikilink tagged with
 *     that `type` attribute. The freshly-written file is picked up by the
 *     vault watcher and the resolver cache refreshes within a render cycle,
 *     so the wikilink flips from dotted (unresolved) to solid (resolved).
 *
 * Click handlers use `onMouseDown preventDefault` so the editor doesn't
 * blur (and trigger an autosave) while the picker is being navigated.
 */
export const WikilinkPicker = forwardRef<WikilinkPickerHandle, Props>(
  function WikilinkPicker({ state }, ref) {
    const [selected, setSelected] = useState(0);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const pickerRef = useRef<HTMLDivElement>(null);

    const trimmed = state.query.trim();
    const search = useSearch(trimmed, 8);
    const { create: createPerson } = usePeopleMutations();
    const { create: createNote } = useNoteMutations();
    const { data: areasData } = useAreas();
    // Defaults for picker-driven creation. "personal" is always seeded, so
    // it's a safe fallback when useAreas hasn't resolved yet (or in non-
    // Tauri test/preview contexts). Color "teal" matches new-person-form.tsx
    // default. The user can edit area/role/email on the person's detail
    // page after the wikilink resolves.
    const defaultArea = areasData?.[0]?.id ?? "personal";

    // Commit a picker row. For "create" rows we AWAIT the matching create
    // mutation before inserting the wikilink atom, then seed the resolver
    // cache synchronously. By the time `state.command(selection)` runs the
    // person/note has been written to disk and upserted into the shared
    // `["people"]` / `["notes"]` cache, which is the single source of
    // truth for the detail page (see use-people.ts). PersonDetail
    // mounts and selects the row immediately — no race possible.
    //
    // `addWikilinkTarget` patches the resolver cache in the same tick so
    // the wikilink atom is immediately clickable. The next bridge refetch
    // — triggered by the watcher's event for the freshly-written file —
    // overwrites this with the full snapshot.
    //
    // Insertion still proceeds on create failure (e.g. no Tauri runtime in
    // tests) — we always want the bracketed text in the doc.
    const commit = async (selection: WikilinkPickerSelection) => {
      if (selection.kind === "create") {
        const text = selection.text.trim();
        if (text) {
          try {
            if (selection.type === "person") {
              const created = await createPerson.mutateAsync({
                name: text,
                role: "",
                company: "",
                email: "",
                area: defaultArea,
              });
              addWikilinkTarget({
                kind: "person",
                docId: created.id,
                title: created.name,
                href: `/people/${created.id}`,
              });
            } else if (selection.type === "note") {
              const created = await createNote.mutateAsync({
                title: text,
                area: defaultArea,
              });
              addWikilinkTarget({
                kind: "note",
                docId: created.id,
                title: created.title,
                href: `/notebook/${created.id}`,
              });
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("wikilink-picker create failed", err);
          }
        }
      }
      state.command(selection);
    };

    const rows = useMemo<Row[]>(() => {
      const existing: Row[] = (search.data ?? []).map((hit: SearchHit) => ({
        key: `existing:${hit.docId}`,
        label: hit.title,
        detail: hit.hint ?? hit.kind,
        icon: KIND_ICON[hit.kind] ?? FileText,
        selection: { kind: "existing", text: hit.title },
      }));
      // Don't show create rows unless the user has typed something — empty
      // query just shows recent matches (which means the existing list).
      const create: Row[] = trimmed
        ? CREATE_OPTIONS.map((opt) => ({
            key: `create:${opt.type}`,
            label: `${opt.label} "${trimmed}"`,
            icon: Plus,
            selection: { kind: "create", text: trimmed, type: opt.type },
          }))
        : [];
      return [...existing, ...create];
    }, [search.data, trimmed]);

    // Keep the highlight index in bounds as the row list mutates.
    useEffect(() => {
      setSelected((prev) => (prev >= rows.length ? 0 : prev));
    }, [rows.length]);

    useEffect(() => {
      setSelected(0);
    }, [trimmed]);

    useLayoutEffect(() => {
      if (!state.clientRect) return;
      const rect = state.clientRect();
      if (!rect) return;
      const gap = 6;
      const pickerHeight = pickerRef.current?.offsetHeight ?? 0;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openAbove =
        spaceBelow < pickerHeight + gap && rect.top > pickerHeight + gap;
      const top = openAbove
        ? rect.top - gap - pickerHeight
        : rect.bottom + gap;
      setPos({ top, left: rect.left });
    }, [rows.length, state]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelected(
            (prev) =>
              (prev - 1 + rows.length) % Math.max(rows.length, 1),
          );
          return true;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelected((prev) => (prev + 1) % Math.max(rows.length, 1));
          return true;
        }
        if (event.key === "Enter") {
          const row = rows[selected];
          if (row) {
            event.preventDefault();
            commit(row.selection);
            return true;
          }
          return false;
        }
        return false;
      },
    }));

    if (typeof document === "undefined") return null;
    if (!state.clientRect) return null;

    return createPortal(
      <div
        ref={pickerRef}
        data-wikilink-picker
        style={{
          position: "fixed",
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          zIndex: 50,
          visibility: pos ? "visible" : "hidden",
        }}
        className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-1 min-w-[320px] max-h-80 overflow-y-auto"
      >
        <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          {trimmed
            ? rows.length === 0
              ? "Searching…"
              : `Match for “${trimmed}”`
            : "Type to search pages"}
        </div>
        {rows.map((row, i) => {
          const Icon = row.icon;
          const isActive = i === selected;
          const isCreate = row.selection.kind === "create";
          return (
            <button
              key={row.key}
              type="button"
              data-active={isActive ? "true" : undefined}
              className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 transition-colors ${
                isActive
                  ? "bg-foreground/[0.06] text-foreground"
                  : "hover:bg-foreground/[0.04]"
              }`}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => {
                // Prevent the editor from blurring before the command runs.
                e.preventDefault();
              }}
              onClick={() => commit(row.selection)}
            >
              <span
                className={`inline-flex items-center justify-center h-7 w-7 rounded border border-border bg-background shrink-0 ${
                  isCreate
                    ? "text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
              <span className="flex flex-col min-w-0 flex-1">
                <span className="truncate">{row.label}</span>
                {row.detail ? (
                  <span className="text-xs text-muted-foreground truncate">
                    {row.detail}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
        <div className="mt-1 pt-1 border-t border-border flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
          <span>Navigate ↑ ↓ · Insert ↵ · Close esc</span>
        </div>
      </div>,
      document.body,
    );
  },
);
