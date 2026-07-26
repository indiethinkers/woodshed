import { Link } from "@tanstack/react-router";
import type {
  ColumnDto,
  RowDto,
  SelectOption,
  TableDto,
} from "@/lib/hooks/use-tables";
import { selectOptionColor } from "./option-colors";

interface ViewProps {
  table: TableDto;
  rows: RowDto[];
}

/**
 * Gallery view: cards in a responsive grid, like a Pinterest moodboard or a
 * Notion gallery. Each card shows the title column big and up to 3 other
 * fields under it.
 */
export function GalleryView({ table, rows }: ViewProps) {
  const titleColumn =
    table.columns.find((c) => c.type === "text") ?? table.columns[0];
  const otherColumns = titleColumn
    ? table.columns.filter((c) => c.id !== titleColumn.id).slice(0, 4)
    : table.columns.slice(0, 4);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">No rows.</p>
    );
  }

  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
      {rows.map((row) => (
        <Link
          key={row.id}
          to="/databases/$id/$rowId"
          params={{ id: table.id, rowId: row.id }}
          className="block rounded-md border border-border/60 bg-background p-3 hover:border-border hover:shadow-sm transition-all"
        >
          <div className="text-sm font-semibold mb-2 truncate">
            {formatTitle(row, titleColumn)}
          </div>
          <div className="space-y-1">
            {otherColumns
              .filter(
                (col) =>
                  row.cells[col.id] !== undefined && row.cells[col.id] !== null,
              )
              .map((col) => (
                <div
                  key={col.id}
                  className="flex items-baseline gap-2 text-[11px] text-muted-foreground"
                >
                  <span className="shrink-0 text-foreground/50">{col.name}</span>
                  <span className="truncate text-foreground/80">
                    <FieldValue row={row} column={col} />
                  </span>
                </div>
              ))}
          </div>
        </Link>
      ))}
    </div>
  );
}

/**
 * List view: compact vertical list. Title prominent, other fields inline
 * separated by middle dots — Notion's list view feel.
 */
export function ListView({ table, rows }: ViewProps) {
  const titleColumn =
    table.columns.find((c) => c.type === "text") ?? table.columns[0];
  const otherColumns = titleColumn
    ? table.columns.filter((c) => c.id !== titleColumn.id).slice(0, 4)
    : table.columns.slice(0, 4);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">No rows.</p>
    );
  }

  return (
    <ul className="rounded-md border border-border/60 divide-y divide-border/40 overflow-hidden">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            to="/databases/$id/$rowId"
            params={{ id: table.id, rowId: row.id }}
            className="flex items-baseline gap-3 px-3 py-2 hover:bg-muted/30 transition-colors"
          >
            <span className="text-sm font-medium truncate min-w-0 flex-1">
              {formatTitle(row, titleColumn)}
            </span>
            <span className="flex items-baseline gap-2 text-[11px] text-muted-foreground truncate min-w-0">
              {otherColumns
                .filter(
                  (col) =>
                    row.cells[col.id] !== undefined &&
                    row.cells[col.id] !== null,
                )
                .map((col, idx) => (
                  <span key={col.id} className="flex items-baseline gap-2">
                    {idx > 0 && <span className="opacity-40">·</span>}
                    <FieldValue row={row} column={col} />
                  </span>
                ))}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function formatTitle(row: RowDto, col: ColumnDto | undefined): string {
  if (!col) return row.id;
  const v = row.cells[col.id];
  if (v === null || v === undefined || v === "") return "(untitled)";
  return String(v);
}

function FieldValue({ row, column }: { row: RowDto; column: ColumnDto }) {
  const v = row.cells[column.id];
  if (v === null || v === undefined) return null;
  if (column.type === "checkbox") {
    return v === true ? <span>✓</span> : null;
  }
  if (column.type === "select") {
    const opt = (column.options ?? []).find((o) => o.id === v);
    if (!opt) return <span>{String(v)}</span>;
    return <OptionPill option={opt} />;
  }
  if (column.type === "multi_select" && Array.isArray(v)) {
    return (
      <span className="inline-flex flex-wrap gap-1">
        {v.map((id) => {
          const opt = (column.options ?? []).find((o) => o.id === id);
          if (!opt) return null;
          return <OptionPill key={id} option={opt} />;
        })}
      </span>
    );
  }
  return <span>{String(v)}</span>;
}

function OptionPill({ option }: { option: SelectOption }) {
  const c = selectOptionColor(option.color);
  return (
    <span
      className="inline-block px-1.5 py-0 rounded-sm text-[10px] font-medium align-middle"
      style={{
        backgroundColor: `hsl(${c.bg})`,
        color: `hsl(${c.fg})`,
      }}
    >
      {option.name}
    </span>
  );
}
