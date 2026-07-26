import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type {
  CellValue,
  ColumnDto,
  RowDto,
  TableDto,
  ViewDto,
} from "@/lib/hooks/use-tables";

interface CalendarViewProps {
  table: TableDto;
  rows: RowDto[];
  view: ViewDto;
  onAddRow: (initialCells: Record<string, CellValue>) => void;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Month-grid view of a table. Rows are placed on the day matching their
 * `view.group_by` cell (which must be a date column). Clicking an empty day
 * creates a new row with the date prefilled. Clicking a card opens the row
 * detail page.
 */
export function CalendarView({ table, rows, view, onAddRow }: CalendarViewProps) {
  const dateColumnId = view.group_by ?? null;
  const dateColumn = dateColumnId
    ? table.columns.find((c) => c.id === dateColumnId)
    : null;

  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState<{ year: number; month: number }>({
    year: today.getFullYear(),
    month: today.getMonth(),
  });

  if (!dateColumn) {
    return (
      <div className="rounded-md border border-dashed border-border/60 p-6 text-sm text-muted-foreground">
        Pick a date column to organize this calendar by — use the toolbar
        above.
      </div>
    );
  }
  if (dateColumn.type !== "date") {
    return (
      <div className="rounded-md border border-dashed border-border/60 p-6 text-sm text-muted-foreground">
        Calendar views need a date column. &ldquo;{dateColumn.name}&rdquo; is a {dateColumn.type}{" "}
        column.
      </div>
    );
  }

  const titleColumn =
    table.columns.find((c) => c.type === "text") ?? table.columns[0];
  const cells = buildMonthGrid(cursor.year, cursor.month);
  const byDate = groupRowsByDate(rows, dateColumn);

  function shiftMonth(delta: number) {
    setCursor((c) => {
      const next = new Date(c.year, c.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }
  function goToday() {
    setCursor({ year: today.getFullYear(), month: today.getMonth() });
  }

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleString(
    "en-US",
    { month: "long", year: "numeric" },
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">{monthLabel}</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label="Previous month"
            className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/50"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={goToday}
            className="h-7 px-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-sm"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label="Next month"
            className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/50"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="rounded-md border border-border/60 overflow-hidden">
        <div className="grid grid-cols-7 border-b border-border/60 bg-muted/20">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 auto-rows-[minmax(96px,1fr)]">
          {cells.map((cell) => {
            const dateStr = formatDateKey(cell.date);
            const dayRows = byDate.get(dateStr) ?? [];
            const isToday = sameDay(cell.date, today);
            const inMonth = cell.date.getMonth() === cursor.month;
            return (
              <div
                key={dateStr}
                className={`group/day border-r border-b border-border/40 last:border-r-0 [&:nth-child(7n)]:border-r-0 p-1.5 flex flex-col gap-1 ${
                  inMonth ? "" : "bg-muted/10"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-[11px] tabular-nums ${
                      isToday
                        ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background"
                        : inMonth
                          ? "text-foreground/80"
                          : "text-muted-foreground/50"
                    }`}
                  >
                    {cell.date.getDate()}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onAddRow({ [dateColumn.id]: dateStr })
                    }
                    aria-label={`Add row on ${dateStr}`}
                    className="opacity-0 group-hover/day:opacity-100 inline-flex items-center justify-center h-4 w-4 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-opacity"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </div>
                <div className="space-y-0.5 min-h-0 overflow-hidden">
                  {dayRows.slice(0, 3).map((row) => (
                    <Link
                      key={row.id}
                      to="/databases/$id/$rowId"
                      params={{ id: table.id, rowId: row.id }}
                      className="block px-1.5 py-0.5 rounded-sm bg-foreground/[0.04] hover:bg-foreground/[0.08] text-[12px] truncate transition-colors"
                      title={titleValue(row, titleColumn)}
                    >
                      {titleValue(row, titleColumn)}
                    </Link>
                  ))}
                  {dayRows.length > 3 && (
                    <span className="block text-[10px] text-muted-foreground px-1.5">
                      +{dayRows.length - 3} more
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface GridCell {
  date: Date;
}

function buildMonthGrid(year: number, month: number): GridCell[] {
  // Six-week grid starting on the Sunday on or before the 1st.
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const cells: GridCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({ date: d });
  }
  return cells;
}

function groupRowsByDate(
  rows: RowDto[],
  dateColumn: ColumnDto,
): Map<string, RowDto[]> {
  const map = new Map<string, RowDto[]>();
  for (const row of rows) {
    const v = row.cells[dateColumn.id];
    if (typeof v !== "string" || !v) continue;
    // Accept full ISO timestamps; truncate to YYYY-MM-DD.
    const key = v.slice(0, 10);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function titleValue(row: RowDto, col: ColumnDto | undefined): string {
  if (!col) return row.id;
  const v = row.cells[col.id];
  if (v === null || v === undefined || v === "") return "(untitled)";
  if (col.type === "select") {
    const opt = (col.options ?? []).find((o) => o.id === v);
    return opt?.name ?? String(v);
  }
  if (col.type === "multi_select" && Array.isArray(v)) {
    const names = v
      .map((id) => (col.options ?? []).find((o) => o.id === id)?.name)
      .filter(Boolean);
    return names.length > 0 ? names.join(", ") : "(untitled)";
  }
  return String(v);
}
