import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type {
  CellValue,
  ColumnDto,
  RowDto,
  SelectOption,
  TableDto,
  ViewDto,
} from "@/lib/hooks/use-tables";
import { selectOptionColor } from "./option-colors";

interface BoardViewProps {
  table: TableDto;
  rows: RowDto[];
  view: ViewDto;
  onCellChange: (rowId: string, columnId: string, value: CellValue) => void;
  onAddRow: (initialCells: Record<string, CellValue>) => void;
}

/**
 * Kanban-style board. Rows are grouped by `view.group_by` (a select or
 * multi_select column). Each group becomes a column on the board; rows
 * become cards. Drop a card into a different group → updates that cell to
 * the group's option id (or replaces the multi-select array's primary tag).
 *
 * The "primary text" column (first text column, or first column if none)
 * gives each card its title. Other columns render as small key/value rows
 * underneath, like a Notion board card.
 */
export function BoardView({
  table,
  rows,
  view,
  onCellChange,
  onAddRow,
}: BoardViewProps) {
  const groupBy = view.group_by ?? null;
  const groupColumn = groupBy
    ? table.columns.find((c) => c.id === groupBy)
    : null;

  if (!groupColumn) {
    return (
      <div className="rounded-md border border-dashed border-border/60 p-6 text-sm text-muted-foreground">
        Pick a select or multi-select column to group this board by — use the
        toolbar above.
      </div>
    );
  }
  if (groupColumn.type !== "select" && groupColumn.type !== "multi_select") {
    return (
      <div className="rounded-md border border-dashed border-border/60 p-6 text-sm text-muted-foreground">
        Board views need a select or multi-select column. &ldquo;{groupColumn.name}&rdquo; is
        a {groupColumn.type} column.
      </div>
    );
  }

  const titleColumn =
    table.columns.find((c) => c.type === "text") ?? table.columns[0];
  const otherColumns = table.columns.filter(
    (c) => c.id !== titleColumn?.id && c.id !== groupColumn.id,
  );

  const groups = useMemo(
    () => groupRows(rows, groupColumn),
    [rows, groupColumn],
  );

  return (
    <div className="flex gap-3 overflow-x-auto pb-3">
      {groups.map((group) => (
        <BoardColumn
          key={group.optionId ?? "__none__"}
          group={group}
          titleColumn={titleColumn}
          otherColumns={otherColumns}
          tableId={table.id}
          onDropRow={(rowId) => {
            const value = valueForGroup(group.optionId, groupColumn);
            onCellChange(rowId, groupColumn.id, value);
          }}
          onAddRow={() =>
            onAddRow(
              group.optionId
                ? { [groupColumn.id]: valueForGroup(group.optionId, groupColumn) }
                : {},
            )
          }
        />
      ))}
    </div>
  );
}

interface Group {
  optionId: string | null;
  option: SelectOption | null;
  rows: RowDto[];
}

function groupRows(rows: RowDto[], groupColumn: ColumnDto): Group[] {
  const options = groupColumn.options ?? [];
  const buckets = new Map<string, Group>();
  for (const opt of options) {
    buckets.set(opt.id, { optionId: opt.id, option: opt, rows: [] });
  }
  const orphan: Group = { optionId: null, option: null, rows: [] };
  for (const row of rows) {
    const v = row.cells[groupColumn.id];
    let placed = false;
    if (groupColumn.type === "select" && typeof v === "string" && v) {
      const bucket = buckets.get(v);
      if (bucket) {
        bucket.rows.push(row);
        placed = true;
      }
    } else if (groupColumn.type === "multi_select" && Array.isArray(v) && v.length > 0) {
      // Multi-select card appears under each tag it has — Notion's
      // "show in every group" semantics. Cards are duplicated visually but
      // editing one still mutates the same row.
      for (const tag of v) {
        const bucket = buckets.get(String(tag));
        if (bucket) {
          bucket.rows.push(row);
          placed = true;
        }
      }
    }
    if (!placed) orphan.rows.push(row);
  }
  const result = options
    .map((opt) => buckets.get(opt.id)!)
    .filter((g): g is Group => !!g);
  if (orphan.rows.length > 0) result.push(orphan);
  // Always include an "Uncategorized" column the user can drag cards into,
  // even when empty — otherwise there's no way to clear a tag from the board.
  else result.push(orphan);
  return result;
}

function valueForGroup(
  optionId: string | null,
  groupColumn: ColumnDto,
): CellValue {
  if (optionId === null) return null;
  if (groupColumn.type === "multi_select") return [optionId];
  return optionId;
}

function BoardColumn({
  group,
  titleColumn,
  otherColumns,
  tableId,
  onDropRow,
  onAddRow,
}: {
  group: Group;
  titleColumn: ColumnDto | undefined;
  otherColumns: ColumnDto[];
  tableId: string;
  onDropRow: (rowId: string) => void;
  onAddRow: () => void;
}) {
  const [hovering, setHovering] = useState(false);
  const headerColor = group.option
    ? selectOptionColor(group.option.color)
    : null;

  return (
    <div
      className={`shrink-0 w-72 rounded-md p-2 transition-colors ${
        hovering ? "bg-muted/40" : "bg-muted/10"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setHovering(true);
      }}
      onDragLeave={() => setHovering(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHovering(false);
        const rowId = e.dataTransfer.getData("text/plain");
        if (rowId) onDropRow(rowId);
      }}
    >
      <div className="flex items-center justify-between px-1.5 mb-2">
        {group.option ? (
          <span
            className="inline-block px-2 py-0.5 rounded-sm text-xs font-medium"
            style={{
              backgroundColor: `hsl(${headerColor!.bg})`,
              color: `hsl(${headerColor!.fg})`,
            }}
          >
            {group.option.name}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground italic">Uncategorized</span>
        )}
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {group.rows.length}
        </span>
      </div>
      <div className="space-y-1.5">
        {group.rows.map((row) => (
          <BoardCard
            key={`${group.optionId ?? "none"}-${row.id}`}
            tableId={tableId}
            row={row}
            titleColumn={titleColumn}
            otherColumns={otherColumns}
          />
        ))}
        <button
          type="button"
          onClick={onAddRow}
          className="flex items-center gap-1 w-full px-2 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/40 rounded-sm transition-colors"
        >
          <Plus className="h-3 w-3" />
          New
        </button>
      </div>
    </div>
  );
}

function BoardCard({
  tableId,
  row,
  titleColumn,
  otherColumns,
}: {
  tableId: string;
  row: RowDto;
  titleColumn: ColumnDto | undefined;
  otherColumns: ColumnDto[];
}) {
  const titleValue = titleColumn
    ? formatCardValue(row.cells[titleColumn.id], titleColumn)
    : "(untitled)";

  return (
    <Link
      to="/databases/$id/$rowId"
      params={{ id: tableId, rowId: row.id }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", row.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="block rounded-sm border border-border/60 bg-background px-2.5 py-2 text-sm cursor-grab active:cursor-grabbing hover:border-border transition-colors"
    >
      <div className="font-medium truncate" title={titleValue}>
        {titleValue}
      </div>
      {otherColumns.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {otherColumns
            .filter((col) => row.cells[col.id] !== undefined && row.cells[col.id] !== null)
            .slice(0, 4)
            .map((col) => (
              <div
                key={col.id}
                className="flex items-baseline gap-2 text-[11px] text-muted-foreground"
              >
                <span className="shrink-0">{col.name}</span>
                <span className="truncate text-foreground/80">
                  {formatCardValue(row.cells[col.id], col)}
                </span>
              </div>
            ))}
        </div>
      )}
    </Link>
  );
}

function formatCardValue(value: unknown, column: ColumnDto): string {
  if (value === null || value === undefined) return "";
  if (column.type === "select") {
    const opt = (column.options ?? []).find((o) => o.id === value);
    return opt?.name ?? String(value);
  }
  if (column.type === "multi_select" && Array.isArray(value)) {
    const names = value
      .map((v) => (column.options ?? []).find((o) => o.id === v)?.name)
      .filter(Boolean);
    return names.join(", ");
  }
  if (column.type === "checkbox") return value ? "✓" : "";
  return String(value);
}
