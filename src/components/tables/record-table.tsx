import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Database,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FilePathLine } from "@/components/shared/file-path-pill";
import { FilterControl, SortControl } from "@/components/tables/view-controls";
import type {
  CellValue,
  ColumnType,
  SelectOption,
  ViewFilters,
  ViewSort,
} from "@/lib/hooks/use-tables";

/**
 * A column in a {@link RecordTable}. Mirrors the generated-database columns
 * the `#event` tag table renders, generalized over an arbitrary row type:
 * `value` feeds sorting / filtering / search, `render` optionally overrides
 * the cell body (defaults to a muted, type-aware rendering of `value`).
 */
export interface RecordColumn<T> {
  id: string;
  name: string;
  type: ColumnType;
  icon: ElementType;
  /** Pixel width of the column. */
  width: number;
  options?: SelectOption[];
  /** Right-align the cell body (numbers / durations). */
  align?: "right";
  /** Render the default cell body in a monospace face (paths, ids). */
  mono?: boolean;
  /** Value used for sort / filter / search. */
  value: (row: T) => CellValue;
  /** Custom cell body. Falls back to a type-aware default when omitted. */
  render?: (row: T, href: string) => ReactNode;
}

interface RecordTableProps<T> {
  rows: T[];
  columns: RecordColumn<T>[];
  loading?: boolean;
  rowKey: (row: T) => string;
  rowHref: (row: T) => string;
  /** Optional visual grouping applied after the current filters and sorts. */
  groupBy?: (row: T) => string;
  /** Preferred group order; unlisted groups follow alphabetically. */
  groupOrder?: readonly string[];
  /** Big page title — matches the `#tag` heading on the event table. */
  title: string;
  /** Noun used in the "visible / total" count, e.g. "notes". */
  unit?: string;
  /** Top-right header slot (create buttons, etc.). */
  action?: ReactNode;
  query: string;
  onQueryChange: (value: string) => void;
  searchPlaceholder?: string;
  filters: ViewFilters;
  onFiltersChange: (filters: ViewFilters) => void;
  sorts: ViewSort[];
  onSortsChange: (sorts: ViewSort[]) => void;
  /** When true, the "Reset view" affordance shows. */
  hasActiveView: boolean;
  onResetView: () => void;
  /** Right side of the view-tab row (e.g. time-window tabs). */
  toolbarExtras?: ReactNode;
  /** Whether to show the single-view "Table" tab. Defaults to true. */
  showViewTab?: boolean;
  /** Show just the total until search or filters narrow the table. */
  totalOnlyWhenUnfiltered?: boolean;
  /** Render empty values as a quiet em dash instead of the word "Empty". */
  quietEmptyCells?: boolean;
  /** Right side of the search / filter / sort row (e.g. a capture input). */
  controlsEnd?: ReactNode;
  /** Rendered between the controls and the grid (inline create forms). */
  aboveGrid?: ReactNode;
  /** Applied before search / filter / sort (e.g. a time-window filter). */
  prefilter?: (rows: T[]) => T[];
  emptyMessage?: string;
  /**
   * Rendered in place of the empty message when the list query failed and
   * there's no cached data. Lets a surface show an honest "couldn't load /
   * retry" affordance instead of the misleading empty state (which reads as
   * "you have no records" — and, with a create action, invites duplicates).
   */
  errorState?: ReactNode;
  /**
   * Enables row selection. When provided, each row gets a checkbox (with a
   * select-all header) and a bulk-action bar appears while rows are selected;
   * confirming the delete invokes this with the selected rows. Omit to render
   * a read-only table with no checkboxes.
   */
  onBulkDelete?: (rows: T[]) => void | Promise<unknown>;
  /** Human label for a row in the delete-confirmation list. Defaults to the
   *  first column's value. */
  rowLabel?: (row: T) => string;
  /**
   * Enables the hover star in the title cell. Starred records surface in
   * the surface's Favorites sidebar; the flag persists to frontmatter.
   */
  favorite?: {
    isFavorite: (row: T) => boolean;
    onToggle: (row: T) => void;
  };
}

export function RecordTable<T>({
  rows,
  columns,
  loading = false,
  rowKey,
  rowHref,
  groupBy,
  groupOrder,
  title,
  unit = "rows",
  action,
  query,
  onQueryChange,
  searchPlaceholder = "Search rows",
  filters,
  onFiltersChange,
  sorts,
  onSortsChange,
  hasActiveView,
  onResetView,
  toolbarExtras,
  showViewTab = true,
  totalOnlyWhenUnfiltered = false,
  quietEmptyCells = false,
  controlsEnd,
  aboveGrid,
  prefilter,
  emptyMessage = "No rows match this view.",
  errorState,
  onBulkDelete,
  rowLabel,
  favorite,
}: RecordTableProps<T>) {
  const visibleRows = useMemo(
    () => applyView({ columns, filters, prefilter, query, rows, sorts }),
    [columns, filters, prefilter, query, rows, sorts],
  );

  const selectable = !!onBulkDelete;
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  // Selection only tracks rows the user can currently see — filtering a row
  // out drops it from the active selection by construction.
  const selectedRows = useMemo(
    () => (selectable ? visibleRows.filter((row) => selectedKeys.has(rowKey(row))) : []),
    [selectable, visibleRows, selectedKeys, rowKey],
  );

  function toggleRow(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    const visibleKeys = visibleRows.map(rowKey);
    const allSelected =
      visibleKeys.length > 0 && visibleKeys.every((key) => selectedKeys.has(key));
    setSelectedKeys(allSelected ? new Set() : new Set(visibleKeys));
  }

  function clearSelection() {
    setSelectedKeys(new Set());
  }

  async function confirmDelete() {
    const targets = selectedRows;
    setConfirming(false);
    clearSelection();
    if (targets.length > 0) await onBulkDelete?.(targets);
  }

  const labelFor = (row: T) =>
    rowLabel?.(row) || asText(columns[0]?.value(row) ?? "") || "(untitled)";
  const showCountFraction =
    !totalOnlyWhenUnfiltered ||
    query.trim().length > 0 ||
    filters.conditions.length > 0;

  return (
    <div className="w-full pb-24">
      <header className="mb-5 w-full">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="min-w-0 text-[32px] font-bold leading-tight tracking-normal text-foreground">
              {title}
            </h1>
            <FilePathLine className="mt-1.5" />
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
              {showCountFraction && `${visibleRows.length} / `}
              {rows.length} {unit}
            </span>
            {action}
          </div>
        </div>
      </header>

      {(showViewTab || toolbarExtras) && (
        <div className="mb-2 flex items-center justify-between gap-3 border-b border-border/50 pb-1">
          {showViewTab ? (
            <div className="flex items-center gap-0.5">
              <ViewTab
                active
                icon={<Database className="h-3.5 w-3.5" />}
                label="Table"
              />
            </div>
          ) : (
            <span />
          )}
          {toolbarExtras}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <SearchBox
          value={query}
          placeholder={searchPlaceholder}
          onChange={onQueryChange}
        />
        <FilterControl
          columns={columns}
          filters={filters}
          onChange={onFiltersChange}
        />
        <SortControl columns={columns} sorts={sorts} onChange={onSortsChange} />
        {hasActiveView && (
          <button
            type="button"
            onClick={onResetView}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-3 w-3" />
            Reset view
          </button>
        )}
        {controlsEnd && <div className="ml-auto">{controlsEnd}</div>}
      </div>

      {aboveGrid}

      {/* Reserve the bulk-action bar's height at all times so selecting a row
          slides the bar into a fixed slot instead of pushing the grid down. */}
      {selectable && (
        <div className="mb-2 h-9">
          {selectedRows.length > 0 && (
            <BulkActionBar
              count={selectedRows.length}
              unit={unit}
              onClear={clearSelection}
              onDelete={() => setConfirming(true)}
            />
          )}
        </div>
      )}

      <RecordTableGrid
        columns={columns}
        emptyMessage={emptyMessage}
        errorState={errorState}
        loading={loading}
        rowHref={rowHref}
        rowKey={rowKey}
        rows={visibleRows}
        groupBy={groupBy}
        groupOrder={groupOrder}
        unit={unit}
        sorts={sorts}
        onSort={onSortsChange}
        selectable={selectable}
        selectedKeys={selectedKeys}
        onToggleRow={toggleRow}
        onToggleAll={toggleAll}
        favorite={favorite}
        quietEmptyCells={quietEmptyCells}
      />

      {selectable && (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {selectedRows.length}{" "}
                {selectedRows.length === 1 ? "item" : "items"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This moves the underlying file
                {selectedRows.length === 1 ? "" : "s"} to the vault's
                recoverable Woodshed trash.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="max-h-48 overflow-y-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[13px]">
              {selectedRows.slice(0, 8).map((row) => (
                <li key={rowKey(row)} className="truncate py-0.5 text-foreground">
                  {labelFor(row)}
                </li>
              ))}
              {selectedRows.length > 8 && (
                <li className="py-0.5 text-muted-foreground">
                  + {selectedRows.length - 8} more
                </li>
              )}
            </ul>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void confirmDelete()}>
                Delete {selectedRows.length}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function BulkActionBar({
  count,
  unit,
  onClear,
  onDelete,
}: {
  count: number;
  unit: string;
  onClear: () => void;
  onDelete: () => void;
}) {
  const noun = count === 1 ? singularize(unit) : unit;
  return (
    <div className="flex h-9 items-center gap-2 rounded-md border border-border/60 bg-accent/50 px-2 text-[13px]">
      <span className="font-medium">
        {count} {noun} selected
      </span>
      <button
        type="button"
        onClick={onDelete}
        className="ml-auto inline-flex h-7 items-center gap-1 rounded-sm px-2 text-[12px] text-foreground transition-colors hover:bg-foreground/[0.05]"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function singularize(unit: string): string {
  if (unit.endsWith("ies")) return `${unit.slice(0, -3)}y`;
  if (unit === "people") return "person";
  if (unit.endsWith("s")) return unit.slice(0, -1);
  return unit;
}

const ROW_HEIGHT = 36; // h-9 on DatabaseRow — every cell truncates to one line

/**
 * Windowed row rendering. Record tables scroll on the ContentPanel viewport
 * (`[data-woodshed-content-scroll]`), so the visible index range is derived
 * from the row container's position inside that viewport and everything
 * outside it collapses into two fixed-height spacers. Rows are a uniform
 * 36px, which keeps the math exact without measuring. Mounting the full
 * vault (two router Links per row) is what made navigating to a table
 * route sluggish. Without a viewport ancestor (tests, non-app embeds)
 * every row renders.
 */
function useVisibleRowRange(
  rowCount: number,
  bodyRef: RefObject<HTMLDivElement | null>,
): [number, number] {
  const OVERSCAN = 12;
  const [range, setRange] = useState<[number, number]>([
    0,
    Math.min(rowCount, OVERSCAN * 2),
  ]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const scrollEl = body?.closest(
      "[data-woodshed-content-scroll]",
    ) as HTMLElement | null;
    if (!body || !scrollEl) {
      setRange([0, rowCount]);
      return;
    }

    const update = () => {
      const current = bodyRef.current;
      if (!current) return;
      // Row container's top relative to the viewport's visible top — robust
      // against the header above the grid changing height (filters, inline
      // create forms) without any scroll-margin bookkeeping.
      const top =
        current.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top;
      const start = Math.max(0, Math.floor(-top / ROW_HEIGHT) - OVERSCAN);
      const end = Math.min(
        rowCount,
        Math.ceil((scrollEl.clientHeight - top) / ROW_HEIGHT) + OVERSCAN,
      );
      setRange((prev) =>
        prev[0] === start && prev[1] === end ? prev : [start, end],
      );
    };

    update();
    scrollEl.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scrollEl);
    // The viewport's content wrapper catches layout shifts above the grid
    // (e.g. the bulk bar or an inline create form appearing).
    if (scrollEl.firstElementChild) observer.observe(scrollEl.firstElementChild);
    return () => {
      scrollEl.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [rowCount, bodyRef]);

  return range;
}

function RecordTableGrid<T>({
  columns,
  emptyMessage,
  errorState,
  loading,
  rowHref,
  rowKey,
  rows,
  groupBy,
  groupOrder,
  unit,
  sorts,
  onSort,
  selectable,
  selectedKeys,
  onToggleRow,
  onToggleAll,
  favorite,
  quietEmptyCells,
}: {
  columns: RecordColumn<T>[];
  emptyMessage: string;
  errorState?: ReactNode;
  loading: boolean;
  rowHref: (row: T) => string;
  rowKey: (row: T) => string;
  rows: T[];
  groupBy?: (row: T) => string;
  groupOrder?: readonly string[];
  unit: string;
  sorts: ViewSort[];
  onSort: (sorts: ViewSort[]) => void;
  selectable: boolean;
  selectedKeys: Set<string>;
  onToggleRow: (key: string) => void;
  onToggleAll: () => void;
  favorite?: {
    isFavorite: (row: T) => boolean;
    onToggle: (row: T) => void;
  };
  quietEmptyCells: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyEntries = useMemo<TableBodyEntry<T>[]>(() => {
    if (!groupBy) {
      return rows.map((row) => ({ type: "row", row }));
    }

    const groups = new Map<string, T[]>();
    for (const row of rows) {
      const key = groupBy(row);
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else groups.set(key, [row]);
    }

    const ranks = new Map(groupOrder?.map((key, index) => [key, index]));
    const keys = [...groups.keys()].sort((a, b) => {
      const aRank = ranks.get(a) ?? Number.MAX_SAFE_INTEGER;
      const bRank = ranks.get(b) ?? Number.MAX_SAFE_INTEGER;
      return aRank - bRank || a.localeCompare(b);
    });

    return keys.flatMap((key) => {
      const groupRows = groups.get(key) ?? [];
      return [
        { type: "group" as const, key, count: groupRows.length },
        ...groupRows.map((row) => ({ type: "row" as const, row })),
      ];
    });
  }, [groupBy, groupOrder, rows]);
  const [start, end] = useVisibleRowRange(bodyEntries.length, bodyRef);

  if (loading) return <TableSkeleton />;

  const visibleKeys = rows.map(rowKey);
  const anySelected = visibleKeys.some((key) => selectedKeys.has(key));

  return (
    <div
      className="min-h-[240px] overflow-x-auto border-y border-border/60"
      style={columnSizing(columns, selectable)}
    >
      <div className="min-w-full" style={{ width: "max-content" }}>
        <Row className="group h-8 border-b border-border/60">
          {selectable && (
            <CellShell
              columnId="__select"
              className="flex items-center justify-center border-r border-border/40"
            >
              <SelectAllCheckbox
                rowKeys={visibleKeys}
                selected={selectedKeys}
                onToggle={onToggleAll}
              />
            </CellShell>
          )}
          {columns.map((column) => (
            <CellShell
              key={column.id}
              columnId={column.id}
              className="flex items-center border-r border-border/40 px-2.5"
            >
              <SortHeader column={column} sorts={sorts} onSort={onSort} />
            </CellShell>
          ))}
          <div className="flex-1" />
        </Row>

        <div ref={bodyRef}>
          {start > 0 && <div aria-hidden style={{ height: start * ROW_HEIGHT }} />}
          {bodyEntries.slice(start, end).map((entry) => {
            if (entry.type === "group") {
              return (
                <DatabaseGroupHeader
                  key={`group:${entry.key}`}
                  count={entry.count}
                  label={entry.key}
                  unit={unit}
                />
              );
            }

            const key = rowKey(entry.row);
            return (
              <DatabaseRow
                key={key}
                columns={columns}
                href={rowHref(entry.row)}
                row={entry.row}
                selectable={selectable}
                isSelected={selectedKeys.has(key)}
                anySelected={anySelected}
                onToggle={() => onToggleRow(key)}
                favorite={favorite}
                quietEmptyCells={quietEmptyCells}
              />
            );
          })}
          {end < bodyEntries.length && (
            <div
              aria-hidden
              style={{ height: (bodyEntries.length - end) * ROW_HEIGHT }}
            />
          )}
        </div>

        {rows.length === 0 &&
          (errorState ? (
            <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 border-b border-border/40 px-6 py-10 text-center">
              {errorState}
            </div>
          ) : (
            <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 border-b border-border/40 px-6 py-10 text-center">
              <Database
                className="h-5 w-5 text-muted-foreground/40"
                strokeWidth={1.5}
              />
              <p className="max-w-sm text-sm text-muted-foreground">
                {emptyMessage}
              </p>
            </div>
          ))}
      </div>
    </div>
  );
}

type TableBodyEntry<T> =
  | { type: "group"; key: string; count: number }
  | { type: "row"; row: T };

function DatabaseGroupHeader({
  count,
  label,
  unit,
}: {
  count: number;
  label: string;
  unit: string;
}) {
  const countLabel = count === 1 ? singularize(unit) : unit;
  return (
    <div
      data-record-group={label}
      className="flex h-9 items-center border-b border-border/30 bg-transparent"
    >
      <div className="sticky left-0 flex min-w-[240px] items-center gap-2.5 px-2.5 pr-3">
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/35 ring-[3px] ring-foreground/[0.04]"
        />
        <h2 className="text-[12px] font-medium text-foreground/90">
          {label}
        </h2>
        <span className="rounded-full bg-muted/70 px-1.5 py-px font-mono text-[10px] tabular-nums text-muted-foreground ring-1 ring-inset ring-border/50">
          {count} {countLabel}
        </span>
      </div>
      <span
        role="separator"
        aria-orientation="horizontal"
        className="mr-3 h-px min-w-12 flex-1 bg-border/60"
      />
    </div>
  );
}

function DatabaseRow<T>({
  columns,
  href,
  row,
  selectable,
  isSelected,
  anySelected,
  onToggle,
  favorite,
  quietEmptyCells,
}: {
  columns: RecordColumn<T>[];
  href: string;
  row: T;
  selectable: boolean;
  isSelected: boolean;
  anySelected: boolean;
  onToggle: () => void;
  favorite?: {
    isFavorite: (row: T) => boolean;
    onToggle: (row: T) => void;
  };
  quietEmptyCells: boolean;
}) {
  return (
    // Fixed h-9: the windowed renderer in RecordTableGrid assumes a
    // uniform ROW_HEIGHT. Every cell truncates, so nothing needs to grow.
    <div
      className={`group flex h-9 items-stretch border-b border-border/40 transition-colors ${
        isSelected ? "bg-accent/40" : "hover:bg-muted/15"
      }`}
    >
      {selectable && (
        <CellShell
          columnId="__select"
          lead
          className="flex items-center justify-center border-r border-border/40"
        >
          <RowCheckbox
            checked={isSelected}
            visible={anySelected || isSelected}
            onChange={onToggle}
          />
        </CellShell>
      )}
      {columns.map((column, index) => (
        <CellShell
          key={column.id}
          columnId={column.id}
          lead={index === 0}
          className="flex min-h-9 items-center border-r border-border/40 px-2.5"
        >
          {index === 0 ? (
            // First (title) column hosts Notion-style hover affordances
            // (star + "Open"), floated over its right edge so they reveal
            // on row hover without reserving layout width or pushing the
            // title.
            <div className="relative flex w-full min-w-0 items-center">
              <div className="min-w-0 flex-1">
                {column.render ? (
                  column.render(row, href)
                ) : (
                  <DefaultCell
                    column={column}
                    row={row}
                    quietEmpty={quietEmptyCells}
                  />
                )}
              </div>
              <div className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-has-[[data-rowlead]:hover]:opacity-100">
                {favorite && (
                  <RowFavoriteButton
                    favorite={favorite.isFavorite(row)}
                    onToggle={() => favorite.onToggle(row)}
                  />
                )}
                <Link
                  to={href}
                  aria-label="Open"
                  onClick={(event) => event.stopPropagation()}
                  className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground shadow-sm transition-colors hover:text-foreground"
                >
                  <ArrowUpRight className="h-3 w-3" />
                  Open
                </Link>
              </div>
            </div>
          ) : column.render ? (
            column.render(row, href)
          ) : (
            <DefaultCell
              column={column}
              row={row}
              quietEmpty={quietEmptyCells}
            />
          )}
        </CellShell>
      ))}
      <div className="flex-1" />
    </div>
  );
}

const SELECT_COL_WIDTH = 36;

function RowFavoriteButton({
  favorite,
  onToggle,
}: {
  favorite: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={favorite}
      aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={`inline-flex h-[22px] w-[22px] items-center justify-center rounded border border-border bg-background shadow-sm transition-colors ${
        favorite
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Star
        className="h-3 w-3"
        strokeWidth={1.8}
        fill={favorite ? "currentColor" : "none"}
      />
    </button>
  );
}

function RowCheckbox({
  checked,
  visible,
  onChange,
}: {
  checked: boolean;
  /** Until selection mode is active, the checkbox only shows while the cursor
   *  is over the row's lead zone (select + title cell). */
  visible: boolean;
  onChange: () => void;
}) {
  return (
    // `visibility` (not an opacity fade): WKWebView intermittently fails to
    // invalidate the region after rasterizing the half-faded ring, leaving
    // stale partial-checkbox pixels behind — same family of paint bug as the
    // border→ring workaround on Checkbox below. Hidden-by-visibility nodes
    // are never painted, so there's no intermediate frame to strand.
    <span
      className={visible ? "" : "invisible group-has-[[data-rowlead]:hover]:visible"}
    >
      <Checkbox checked={checked} onChange={onChange} />
    </span>
  );
}

function SelectAllCheckbox({
  rowKeys,
  selected,
  onToggle,
}: {
  rowKeys: string[];
  selected: Set<string>;
  onToggle: () => void;
}) {
  if (rowKeys.length === 0) return null;
  const selectedCount = rowKeys.filter((key) => selected.has(key)).length;
  const allChecked = selectedCount === rowKeys.length;
  const someChecked = selectedCount > 0 && !allChecked;
  return (
    // Visibility keys off the VISIBLE selection count (`selected` can hold
    // keys of rows that have since been filtered out) and off
    // :focus-visible rather than :focus-within — a mouse click leaves the
    // checkbox focused, which used to pin it visible after deselecting.
    // `visibility` toggle, no opacity fade — see the note on RowCheckbox.
    <span
      className={
        selectedCount > 0
          ? ""
          : "invisible group-hover:visible has-[:focus-visible]:visible"
      }
    >
      <Checkbox
        checked={allChecked}
        indeterminate={someChecked}
        onChange={onToggle}
      />
    </span>
  );
}

function Checkbox({
  checked,
  indeterminate = false,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
      // Outline via an inset ring (box-shadow) rather than a `border`: in
      // WKWebView a 14px transparent box with a 1px border + radius +
      // color transition intermittently drops its bottom/right edges
      // (the broken "⌐" render). A box-shadow paints as one shape and
      // doesn't.
      className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm ring-1 ring-inset transition-colors ${
        checked || indeterminate
          ? "bg-foreground ring-foreground"
          : "bg-transparent ring-muted-foreground/40 hover:ring-foreground/70"
      }`}
    >
      {indeterminate ? (
        <span className="block h-[2px] w-2 bg-background" />
      ) : checked ? (
        <svg
          viewBox="0 0 12 12"
          className="h-2.5 w-2.5 text-background"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M2.5 6.5l2.2 2.2L9.5 3.8" />
        </svg>
      ) : null}
    </button>
  );
}

function DefaultCell<T>({
  column,
  row,
  quietEmpty,
}: {
  column: RecordColumn<T>;
  row: T;
  quietEmpty: boolean;
}) {
  const value = column.value(row);

  if (quietEmpty && isEmpty(value)) {
    return (
      <span
        aria-label="Empty"
        className="block text-[13px] text-muted-foreground/30"
      >
        —
      </span>
    );
  }

  if (column.type === "date") {
    return (
      <span className="font-mono text-[12px] text-muted-foreground">
        {formatDate(asText(value))}
      </span>
    );
  }

  if (column.type === "number" || column.align === "right") {
    return (
      <span className="w-full text-right font-mono text-[12px] tabular-nums text-muted-foreground">
        {isEmpty(value) ? "Empty" : asText(value)}
      </span>
    );
  }

  const text = asText(value);
  return (
    <span
      className={`block truncate text-[13px] text-muted-foreground${
        column.mono ? " font-mono text-[12px]" : ""
      }`}
    >
      {text || "Empty"}
    </span>
  );
}

/**
 * A foreground, icon-led link cell — the standard rendering for a table's
 * title column. Matches the wikilink hover pattern used across Woodshed.
 */
export function RecordLinkCell({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon?: ElementType;
  children: ReactNode;
}) {
  return (
    <Link
      to={href}
      className="flex min-w-0 items-center gap-2 rounded-sm text-[14px] font-medium text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
    >
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <span className="truncate">{children || "(untitled)"}</span>
    </Link>
  );
}

function SearchBox({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="inline-flex h-8 min-w-[240px] items-center gap-2 rounded-md border border-border/70 bg-background/50 px-2.5 text-[13px] focus-within:ring-2 focus-within:ring-foreground/15">
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50"
      />
    </label>
  );
}

function SortHeader<T>({
  column,
  sorts,
  onSort,
}: {
  column: RecordColumn<T>;
  sorts: ViewSort[];
  onSort: (sorts: ViewSort[]) => void;
}) {
  const activeIndex = sorts.findIndex((sort) => sort.column === column.id);
  const active = activeIndex !== -1;
  const current = active ? sorts[activeIndex] : null;
  const Icon = column.icon;
  return (
    <button
      type="button"
      onClick={() => {
        const nextDirection = current?.direction === "asc" ? "desc" : "asc";
        onSort([
          { column: column.id, direction: nextDirection },
          ...sorts.filter((sort) => sort.column !== column.id),
        ]);
      }}
      className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{column.name}</span>
      {active &&
        (current?.direction === "asc" ? (
          <ArrowUp className="h-3 w-3 shrink-0" />
        ) : (
          <ArrowDown className="h-3 w-3 shrink-0" />
        ))}
      {active && sorts.length > 1 && (
        <span className="rounded-sm bg-muted px-1 font-mono text-[10px] text-muted-foreground">
          {activeIndex + 1}
        </span>
      )}
    </button>
  );
}

function ViewTab({
  active,
  icon,
  label,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors ${
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      }`}
    >
      <span className="text-muted-foreground/70">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// Mirrors the real grid's bones (header row + bordered 36px rows) so the
// loaded table lands on the same layout instead of jumping.
function TableSkeleton() {
  return (
    <div className="min-h-[240px] animate-pulse border-y border-border/60">
      <div className="flex h-8 items-center gap-6 border-b border-border/60 px-2.5">
        <div className="h-3 w-24 rounded bg-muted" />
        <div className="h-3 w-16 rounded bg-muted" />
        <div className="h-3 w-16 rounded bg-muted" />
      </div>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div
          key={i}
          className="flex h-9 items-center gap-6 border-b border-border/40 px-2.5"
        >
          <div
            className="h-3 rounded bg-muted"
            style={{ width: `${[40, 56, 32, 48, 36, 52, 44, 28][i]}%`, maxWidth: 280 }}
          />
        </div>
      ))}
    </div>
  );
}

function Row({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={`flex items-stretch ${className}`}>{children}</div>;
}

function CellShell({
  columnId,
  className = "",
  children,
  lead = false,
}: {
  columnId: string;
  className?: string;
  children?: ReactNode;
  /** Marks this cell as part of the row's "lead" hover zone (select +
   *  title): hover affordances reveal on `group-has-[[data-rowlead]:hover]`
   *  so they stay hidden while the cursor is over the trailing columns. */
  lead?: boolean;
}) {
  return (
    <div
      data-rowlead={lead ? "" : undefined}
      className={`shrink-0 min-w-0 ${className}`}
      style={{ width: `var(--col-${columnId}-size)` }}
    >
      {children}
    </div>
  );
}

/**
 * View-state container shared by every record table. Holds the search query,
 * filter group, and sort stack, and resets them to the supplied defaults.
 */
export function useRecordTableState(defaultSorts: ViewSort[]) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<ViewFilters>(() => emptyFilters());
  const [sorts, setSorts] = useState<ViewSort[]>(defaultSorts);

  const reset = useCallback(() => {
    setQuery("");
    setFilters(emptyFilters());
    setSorts(defaultSorts);
  }, [defaultSorts]);

  const isDirty =
    query.trim().length > 0 ||
    filters.conditions.length > 0 ||
    !sortsEqual(sorts, defaultSorts);

  return {
    query,
    setQuery,
    filters,
    setFilters,
    sorts,
    setSorts,
    reset,
    isDirty,
  };
}

function columnSizing<T>(
  columns: RecordColumn<T>[],
  selectable: boolean,
): CSSProperties {
  const sizing: Record<string, string> = {};
  if (selectable) sizing["--col-__select-size"] = `${SELECT_COL_WIDTH}px`;
  for (const column of columns) {
    sizing[`--col-${column.id}-size`] = `${column.width}px`;
  }
  return sizing as CSSProperties;
}

export function emptyFilters(): ViewFilters {
  return { op: "and", conditions: [] };
}

/**
 * Build select-filter options from the distinct values present in a column —
 * mirrors how the `#event` tag table derives its Area/Type options so the
 * filter dropdown lists real choices instead of an empty picker.
 */
export function selectOptionsFromValues(values: string[]): SelectOption[] {
  const palette = ["blue", "teal", "amber", "purple", "coral", "pink", "gray"];
  const distinct = [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  return distinct.map((value, index) => ({
    id: value,
    name: value,
    color: palette[index % palette.length],
  }));
}

export function sortsEqual(a: ViewSort[], b: ViewSort[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (sort, index) =>
      sort.column === b[index]?.column &&
      sort.direction === b[index]?.direction,
  );
}

function applyView<T>({
  columns,
  filters,
  prefilter,
  query,
  rows,
  sorts,
}: {
  columns: RecordColumn<T>[];
  filters: ViewFilters;
  prefilter?: (rows: T[]) => T[];
  query: string;
  rows: T[];
  sorts: ViewSort[];
}): T[] {
  let out = prefilter ? prefilter(rows) : rows;

  const needle = query.trim().toLowerCase();
  if (needle) {
    out = out.filter((row) => searchHaystack(columns, row).includes(needle));
  }

  if (filters.conditions.length > 0) {
    out = out.filter((row) => {
      const results = filters.conditions.map((condition) =>
        evaluateCondition(columns, row, condition),
      );
      return filters.op === "or" ? results.some(Boolean) : results.every(Boolean);
    });
  }

  if (sorts.length > 0) {
    out = [...out].sort((a, b) => compareRows(columns, a, b, sorts));
  }

  return out;
}

function evaluateCondition<T>(
  columns: RecordColumn<T>[],
  row: T,
  filter: { column: string; op: string; value?: unknown },
): boolean {
  const column = columns.find((candidate) => candidate.id === filter.column);
  if (!column) return true;
  const value = column.value(row);

  switch (filter.op) {
    case "is_empty":
      return isEmpty(value);
    case "is":
    case "eq":
    case "on":
      return String(value ?? "") === String(filter.value ?? "");
    case "is_not":
    case "neq":
      return String(value ?? "") !== String(filter.value ?? "");
    case "contains":
      return String(value ?? "")
        .toLowerCase()
        .includes(String(filter.value ?? "").toLowerCase());
    case "gt":
      return (
        typeof value === "number" &&
        typeof filter.value === "number" &&
        value > filter.value
      );
    case "lt":
      return (
        typeof value === "number" &&
        typeof filter.value === "number" &&
        value < filter.value
      );
    case "before":
      return (
        typeof value === "string" &&
        typeof filter.value === "string" &&
        value < filter.value
      );
    case "after":
      return (
        typeof value === "string" &&
        typeof filter.value === "string" &&
        value > filter.value
      );
    default:
      return true;
  }
}

function compareRows<T>(
  columns: RecordColumn<T>[],
  a: T,
  b: T,
  sorts: ViewSort[],
): number {
  for (const sort of sorts) {
    const column = columns.find((candidate) => candidate.id === sort.column);
    if (!column) continue;
    const cmp = compareColumn(column, a, b, sort.direction);
    if (cmp !== 0) return cmp;
  }
  const fallback = columns[0];
  return fallback
    ? asText(fallback.value(a)).localeCompare(asText(fallback.value(b)))
    : 0;
}

function compareColumn<T>(
  column: RecordColumn<T>,
  a: T,
  b: T,
  direction: "asc" | "desc",
): number {
  const av = sortValue(column, a);
  const bv = sortValue(column, b);
  const aEmpty = av === null || av === "";
  const bEmpty = bv === null || bv === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  let cmp: number;
  if (typeof av === "number" && typeof bv === "number") {
    cmp = av - bv;
  } else if (column.type === "select") {
    const order = (column.options ?? []).map((option) => option.id);
    const ai = order.indexOf(String(av));
    const bi = order.indexOf(String(bv));
    cmp =
      ai !== -1 && bi !== -1 ? ai - bi : String(av).localeCompare(String(bv));
  } else {
    cmp = String(av).localeCompare(String(bv));
  }
  return direction === "asc" ? cmp : -cmp;
}

function sortValue<T>(
  column: RecordColumn<T>,
  row: T,
): string | number | null {
  const value = column.value(row);
  if (column.type === "date") {
    if (typeof value !== "string" || !value) return null;
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value === "string") return value.toLowerCase();
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return value.join(", ").toLowerCase();
  return value;
}

function searchHaystack<T>(columns: RecordColumn<T>[], row: T): string {
  return columns
    .map((column) => asText(column.value(row)))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function asText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function isEmpty(value: CellValue): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function formatDate(value: string): string {
  if (!value) return "Empty";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
