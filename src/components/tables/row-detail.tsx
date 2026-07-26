import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, Trash2 } from "lucide-react";
import { BacklinksPanel } from "@/components/shared/backlinks-panel";
import { OutgoingLinksPanel } from "@/components/shared/outgoing-links-panel";
import { FilePathLine } from "@/components/shared/file-path-pill";
import { TiptapEditor } from "@/components/shared/tiptap-editor";
import {
  useRow,
  useRowMutations,
  useTable,
  useTableMutations,
  type CellValue,
  type ColumnDto,
  type RowDto,
  type SelectOption,
  type TableDto,
} from "@/lib/hooks/use-tables";
import { Cell } from "./cell";
import { ColumnTypeIcon } from "./column-header";

interface RowDetailProps {
  tableId: string;
  rowId: string;
}

export function RowDetail({ tableId, rowId }: RowDetailProps) {
  const { data: table, isLoading: tableLoading } = useTable(tableId);
  const { data: row, isLoading: rowLoading } = useRow(tableId, rowId);

  if (tableLoading || rowLoading) return <RowSkeleton />;
  if (!table) {
    return <p className="text-sm text-muted-foreground">Table not found.</p>;
  }
  if (!row) {
    return <p className="text-sm text-muted-foreground">Row not found.</p>;
  }
  return <RowDetailInner table={table} row={row} />;
}

function RowSkeleton() {
  return (
    <article className="w-full animate-pulse">
      <div className="h-4 w-24 bg-muted rounded mb-4" />
      <div className="h-7 w-3/4 bg-muted rounded mb-6" />
      <div className="space-y-2">
        <div className="h-6 w-full bg-muted rounded" />
        <div className="h-6 w-full bg-muted rounded" />
        <div className="h-6 w-2/3 bg-muted rounded" />
      </div>
    </article>
  );
}

function RowDetailInner({ table, row }: { table: TableDto; row: RowDto }) {
  const navigate = useNavigate();
  const { update, remove } = useRowMutations(table.id);
  const { update: updateTable } = useTableMutations();

  const titleColumn =
    table.columns.find((c) => c.type === "text") ?? table.columns[0];
  const otherColumns = titleColumn
    ? table.columns.filter((c) => c.id !== titleColumn.id)
    : table.columns;
  const [deleting, setDeleting] = useState(false);

  function commitCell(colId: string, value: CellValue) {
    update.mutate({
      rowId: row.id,
      update: { cells: { [colId]: value } },
    });
  }

  // `mutateAsync` (not `mutate`) so TiptapEditor's wikilink click handler
  // can await the save before navigating. Otherwise unsaved edits get
  // stranded by an immediate route change. See use-daily-journal.ts.
  async function commitBody(next: string) {
    if (next === row.body) return;
    await update.mutateAsync({ rowId: row.id, update: { body: next } });
  }

  function addOption(colId: string, option: SelectOption) {
    const nextColumns = table.columns.map((c) =>
      c.id === colId ? { ...c, options: [...(c.options ?? []), option] } : c,
    );
    updateTable.mutate({ id: table.id, update: { columns: nextColumns } });
  }

  function handleDelete() {
    if (!deleting) {
      setDeleting(true);
      return;
    }
    remove.mutate(
      { rowId: row.id },
      {
        onSuccess: () =>
          void navigate({ replace: true, to: "/databases/$id", params: { id: table.id } }),
      },
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <Link
          to="/databases/$id"
          params={{ id: table.id }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-3 w-3" />
          {table.name}
        </Link>
        <DeleteButton
          deleting={deleting}
          onDelete={handleDelete}
          onCancel={() => setDeleting(false)}
        />
      </div>

      {titleColumn && (
        <div className="mb-6">
          <TitleCell
            column={titleColumn}
            value={row.cells[titleColumn.id] as CellValue | undefined}
            onCommit={(v) => commitCell(titleColumn.id, v)}
            onCreateOption={
              titleColumn.type === "select" || titleColumn.type === "multi_select"
                ? (opt) => addOption(titleColumn.id, opt)
                : undefined
            }
          />
          <FilePathLine className="mt-1.5" />
        </div>
      )}

      <dl className="mb-6 grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 items-center">
        {otherColumns.map((col) => (
          <FieldRow
            key={col.id}
            column={col}
            value={row.cells[col.id] as CellValue | undefined}
            onCommit={(v) => commitCell(col.id, v)}
            onCreateOption={
              col.type === "select" || col.type === "multi_select"
                ? (opt) => addOption(col.id, opt)
                : undefined
            }
          />
        ))}
      </dl>

      <div className="border-t border-border pt-6">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Notes
        </h3>
        <TiptapEditor
          value={row.body}
          onCommit={commitBody}
          placeholder="Add notes about this row…"
          className="text-[15px] leading-normal min-h-[80px]"
        />
      </div>

      <OutgoingLinksPanel sourceId={row.id} />
      <BacklinksPanel targetId={row.id} />
    </div>
  );
}

function FieldRow({
  column,
  value,
  onCommit,
  onCreateOption,
}: {
  column: ColumnDto;
  value: CellValue | undefined;
  onCommit: (v: CellValue) => void;
  onCreateOption?: (option: SelectOption) => void;
}) {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-[12px] text-muted-foreground py-1.5">
        <ColumnTypeIcon type={column.type} />
        <span className="truncate">{column.name}</span>
      </dt>
      <dd className="py-1.5 min-w-0">
        <Cell column={column} value={value} onCommit={onCommit} onCreateOption={onCreateOption} />
      </dd>
    </>
  );
}

/**
 * Larger version of the title column — same Cell editor, but wrapped in a
 * heading-sized frame so the page reads like a Notion row page rather than
 * a stretched grid cell.
 */
function TitleCell({
  column,
  value,
  onCommit,
  onCreateOption,
}: {
  column: ColumnDto;
  value: CellValue | undefined;
  onCommit: (v: CellValue) => void;
  onCreateOption?: (option: SelectOption) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={wrapRef} className="text-2xl font-semibold tracking-tight [&_input]:text-2xl [&_input]:font-semibold [&_button]:text-2xl [&_button]:font-semibold">
      <Cell
        column={column}
        value={value}
        onCommit={onCommit}
        onCreateOption={onCreateOption}
      />
    </div>
  );
}

function DeleteButton({
  deleting,
  onDelete,
  onCancel,
}: {
  deleting: boolean;
  onDelete: () => void;
  onCancel: () => void;
}) {
  if (deleting) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground">Delete this row?</span>
        <button
          type="button"
          onClick={onDelete}
          className="h-7 px-3 rounded-sm bg-accent text-accent-foreground text-[13px]"
        >
          Yes, delete
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-3 rounded-sm border border-border text-[13px] text-foreground hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onDelete}
      aria-label="Delete row"
      className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] shrink-0"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}
