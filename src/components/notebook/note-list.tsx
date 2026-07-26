import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  FileText,
  FolderKanban,
  Hash,
  Plus,
} from "lucide-react";
import {
  RecordLinkCell,
  RecordTable,
  selectOptionsFromValues,
  useRecordTableState,
  type RecordColumn,
} from "@/components/tables/record-table";
import {
  useAllNotes,
  useNoteMutations,
  type NoteDto,
} from "@/lib/hooks/use-notes";
import type { ViewSort } from "@/lib/hooks/use-tables";
export { getMarkdownPreview as getPreview } from "@/lib/markdown-preview";

const DEFAULT_SORTS: ViewSort[] = [{ column: "created", direction: "desc" }];

const COLUMNS: RecordColumn<NoteDto>[] = [
  {
    id: "title",
    name: "Title",
    type: "text",
    icon: FileText,
    width: 380,
    value: (note) => note.title,
    render: (note, href) => (
      <RecordLinkCell href={href} icon={FileText}>
        {note.title}
      </RecordLinkCell>
    ),
  },
  {
    id: "area",
    name: "Area",
    type: "select",
    icon: FolderKanban,
    width: 180,
    value: (note) => note.area ?? null,
  },
  {
    id: "tags",
    name: "Tags",
    type: "text",
    icon: Hash,
    width: 240,
    value: (note) => note.tags.join(", "),
  },
  {
    id: "created",
    name: "Created",
    type: "date",
    icon: CalendarDays,
    width: 170,
    value: (note) => note.created,
  },
];

export function NoteList() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useAllNotes();
  const notes = data ?? [];
  const { create, update, remove } = useNoteMutations();
  const [creating, setCreating] = useState(false);
  const view = useRecordTableState(DEFAULT_SORTS);
  const columns = useMemo(() => withAreaOptions(notes), [notes]);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const note = await create.mutateAsync({ title: "Untitled" });
      void navigate({ to: "/notebook/$id", params: { id: note.id } });
    } finally {
      setCreating(false);
    }
  }

  return (
    <RecordTable
      title="Notebook"
      unit="notes"
      rows={notes}
      columns={columns}
      loading={isLoading}
      rowKey={(note) => note.id}
      rowHref={(note) => `/notebook/${note.id}`}
      showViewTab={false}
      totalOnlyWhenUnfiltered
      quietEmptyCells
      searchPlaceholder="Search notes"
      query={view.query}
      onQueryChange={view.setQuery}
      filters={view.filters}
      onFiltersChange={view.setFilters}
      sorts={view.sorts}
      onSortsChange={view.setSorts}
      hasActiveView={view.isDirty}
      onResetView={view.reset}
      onBulkDelete={(targets) =>
        Promise.all(targets.map((note) => remove.mutateAsync({ id: note.id })))
      }
      favorite={{
        isFavorite: (note) => note.favorite,
        onToggle: (note) =>
          update.mutate({
            id: note.id,
            update: { favorite: !note.favorite },
          }),
      }}
      emptyMessage="No notes yet. Click + to create one."
      errorState={
        // Only when the load actually failed and nothing is cached — a
        // transient backend hiccup must not masquerade as an empty notebook
        // (which would invite creating a duplicate note).
        isError && notes.length === 0 ? (
          <>
            <p className="max-w-sm text-sm text-muted-foreground">
              Couldn&apos;t load your notes. Your files are safe on disk — this
              is just a hiccup talking to the local backend.
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="mt-1 inline-flex items-center rounded-md border border-border px-2.5 py-1 text-sm text-foreground transition-colors hover:bg-foreground/[0.05]"
            >
              Retry
            </button>
          </>
        ) : undefined
      }
      action={
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          aria-label="New note"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-40"
        >
          <Plus className="h-4 w-4" strokeWidth={1.7} />
        </button>
      }
    />
  );
}

function withAreaOptions(notes: NoteDto[]): RecordColumn<NoteDto>[] {
  const options = selectOptionsFromValues(
    notes.map((note) => note.area ?? "").filter(Boolean),
  );
  return COLUMNS.map((column) =>
    column.id === "area" ? { ...column, options } : column,
  );
}
