import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, FileText, GripVertical, Plus, Trash2 } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type ColumnDef,
  type ColumnSizingInfoState,
  getCoreRowModel,
  type Header,
  useReactTable,
} from "@tanstack/react-table";
import {
  useTable,
  useTableMutations,
  useTableRows,
  useRowMutations,
  type CalcFn,
  type CellValue,
  type ColumnDto,
  type ColumnType,
  type RowDto,
  type SelectOption,
  type TableDto,
  type ViewDto,
} from "@/lib/hooks/use-tables";
import { FilePathLine } from "@/components/shared/file-path-pill";
import { Cell } from "./cell";
import { formatNumber } from "./format-number";
import { ColumnHeader, ColumnTypeIcon } from "./column-header";
import { columnTypeLabel } from "./column-utils";
import { BoardView } from "./board-view";
import { CalendarView } from "./calendar-view";
import { GalleryView, ListView } from "./gallery-list-views";
import { FilterControl, SortControl, ViewTabs } from "./view-controls";
import { isEditableElement } from "@/lib/dom/is-editable";

const CALC_FNS: { value: CalcFn; label: string }[] = [
  { value: "sum", label: "Sum" },
  { value: "count", label: "Count" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

export function isTableRowDeleteShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    (event.key === "Delete" || event.key === "Backspace") &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}

export function moveTableRowIds(
  rowIds: string[],
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId) return null;
  const oldIndex = rowIds.indexOf(activeId);
  const newIndex = rowIds.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1) return null;
  return arrayMove(rowIds, oldIndex, newIndex);
}

interface TableViewProps {
  tableId: string;
}

export function TableView({ tableId }: TableViewProps) {
  const { data: table, isLoading: tableLoading } = useTable(tableId);
  const { data: rows = [], isLoading: rowsLoading } = useTableRows(tableId);

  if (tableLoading || rowsLoading) return <TableSkeleton />;
  if (!table) {
    return (
      <p className="text-sm text-muted-foreground">Table not found.</p>
    );
  }
  return <TableViewInner table={table} rows={rows} />;
}

function TableSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-6 w-48 bg-muted rounded" />
      <div className="h-8 w-full bg-muted rounded" />
      <div className="h-10 w-full bg-muted rounded" />
      <div className="h-10 w-full bg-muted rounded" />
      <div className="h-10 w-full bg-muted rounded" />
    </div>
  );
}

function TableViewInner({ table, rows }: { table: TableDto; rows: RowDto[] }) {
  const navigate = useNavigate();
  const { update, remove: removeTable } = useTableMutations();
  const {
    create: createRow,
    update: updateRow,
    remove: removeRow,
    reorder: reorderRows,
  } = useRowMutations(table.id);

  const [activeViewId, setActiveViewId] = useState<string>(table.views[0]?.id ?? "");
  const activeView = useMemo(
    () => table.views.find((v) => v.id === activeViewId) ?? table.views[0] ?? null,
    [table.views, activeViewId],
  );
  // Keep activeViewId synced if views are added/removed externally.
  useEffect(() => {
    if (!table.views.find((v) => v.id === activeViewId)) {
      setActiveViewId(table.views[0]?.id ?? "");
    }
  }, [table.views, activeViewId]);

  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(table.name);
  // Tracks the most recently-created row so its title cell auto-focuses into
  // edit mode after "+ New item". Cleared implicitly when a different row id
  // gets stamped here on the next create.
  const [pendingFocusRowId, setPendingFocusRowId] = useState<string | null>(
    null,
  );
  // Multi-row selection. Set of row ids — bulk edit/delete operate on these.
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const bulkDeleteSelected = useCallback(() => {
    const ids = Array.from(selectedRowIds);
    Promise.all(ids.map((rowId) => removeRow.mutateAsync({ rowId }))).catch(
      () => {
        // Individual mutation rollbacks restore rows if a delete fails.
      },
    );
    setSelectedRowIds(new Set());
  }, [removeRow, selectedRowIds]);

  useEffect(() => {
    function deleteSelectedRows(event: KeyboardEvent) {
      if (
        !isTableRowDeleteShortcut(event) ||
        selectedRowIds.size === 0 ||
        isEditableElement(event.target)
      ) {
        return;
      }
      event.preventDefault();
      bulkDeleteSelected();
    }
    window.addEventListener("keydown", deleteSelectedRows, { capture: true });
    return () =>
      window.removeEventListener("keydown", deleteSelectedRows, { capture: true });
  }, [bulkDeleteSelected, selectedRowIds.size]);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!titleEditing) setTitleDraft(table.name);
  }, [table.name, titleEditing]);
  useEffect(() => {
    if (titleEditing) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [titleEditing]);

  function commitTitle() {
    setTitleEditing(false);
    const next = titleDraft.trim();
    if (!next || next === table.name) {
      setTitleDraft(table.name);
      return;
    }
    update.mutate({ id: table.id, update: { name: next } });
  }

  function patchView(viewId: string, patch: Partial<ViewDto>) {
    const nextViews = table.views.map((v) =>
      v.id === viewId ? { ...v, ...patch } : v,
    );
    update.mutate({ id: table.id, update: { views: nextViews } });
  }

  function patchColumns(next: ColumnDto[]) {
    update.mutate({ id: table.id, update: { columns: next } });
  }

  function addView(type: ViewDto["type"]) {
    const id = `view_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    // group_by drives both board (a select column) and calendar (a date
    // column). Pick a sensible default so the new view renders something.
    const groupBy =
      type === "board"
        ? table.columns.find(
            (c) => c.type === "select" || c.type === "multi_select",
          )?.id ?? null
        : type === "calendar"
          ? table.columns.find((c) => c.type === "date")?.id ?? null
          : null;
    const nextViews: ViewDto[] = [
      ...table.views,
      {
        id,
        name: `View ${table.views.length + 1}`,
        type,
        group_by: groupBy,
      },
    ];
    update.mutate(
      { id: table.id, update: { views: nextViews } },
      { onSuccess: () => setActiveViewId(id) },
    );
  }

  function deleteView(id: string) {
    if (table.views.length <= 1) return;
    const nextViews = table.views.filter((v) => v.id !== id);
    update.mutate(
      { id: table.id, update: { views: nextViews } },
      { onSuccess: () => setActiveViewId(nextViews[0].id) },
    );
  }

  function addColumn(type: ColumnType) {
    const id = `col_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const next: ColumnDto[] = [
      ...table.columns,
      {
        id,
        name: defaultColumnName(table.columns.length, type),
        type,
        ...(type === "select" ? { options: [] } : {}),
      },
    ];
    patchColumns(next);
  }

  function renameColumn(colId: string, name: string) {
    patchColumns(table.columns.map((c) => (c.id === colId ? { ...c, name } : c)));
  }

  function changeColumnType(colId: string, type: ColumnType) {
    patchColumns(
      table.columns.map((c) =>
        c.id === colId
          ? {
              ...c,
              type,
              options: type === "select" ? c.options ?? [] : undefined,
            }
          : c,
      ),
    );
  }

  function patchColumn(colId: string, patch: Partial<ColumnDto>) {
    patchColumns(
      table.columns.map((c) => (c.id === colId ? { ...c, ...patch } : c)),
    );
  }

  function hideColumnInView(colId: string) {
    if (!activeView) return;
    const hidden = activeView.hidden ?? [];
    if (hidden.includes(colId)) return;
    patchView(activeView.id, { hidden: [...hidden, colId] });
  }

  function showAllInView() {
    if (!activeView) return;
    patchView(activeView.id, { hidden: [] });
  }

  function deleteColumn(colId: string) {
    if (table.columns.length <= 1) return;
    patchColumns(table.columns.filter((c) => c.id !== colId));
  }

  function reorderColumn(activeId: string, overId: string) {
    if (activeId === overId) return;
    // Indices in the full columns array — hidden columns keep their absolute
    // positions, visible columns move around them.
    const oldIdx = table.columns.findIndex((c) => c.id === activeId);
    const newIdx = table.columns.findIndex((c) => c.id === overId);
    if (oldIdx === -1 || newIdx === -1) return;
    patchColumns(arrayMove(table.columns, oldIdx, newIdx));
  }

  function resizeColumn(colId: string, width: number) {
    patchColumns(
      table.columns.map((c) =>
        c.id === colId ? { ...c, width: Math.max(60, Math.round(width)) } : c,
      ),
    );
  }

  function addOption(colId: string, option: SelectOption) {
    patchColumns(
      table.columns.map((c) =>
        c.id === colId
          ? { ...c, options: [...(c.options ?? []), option] }
          : c,
      ),
    );
  }

  function setCalculation(colId: string, fn: CalcFn | null) {
    if (!activeView) return;
    const calculations = { ...(activeView.calculations ?? {}) };
    if (fn === null) delete calculations[colId];
    else calculations[colId] = fn;
    patchView(activeView.id, { calculations });
  }

  if (!activeView) {
    return (
      <p className="text-sm text-muted-foreground">No views configured.</p>
    );
  }

  const visibleColumns = table.columns.filter(
    (c) => !(activeView.hidden ?? []).includes(c.id),
  );
  const titleColumnId =
    (visibleColumns.find((c) => c.type === "text") ?? visibleColumns[0])?.id;
  const hiddenCount = (activeView.hidden ?? []).length;
  const visibleRows = applyView(rows, table.columns, activeView);
  const canManuallyOrderRows =
    activeView.type === "table" &&
    (activeView.sorts?.length ?? 0) === 0 &&
    (activeView.filters?.conditions.length ?? 0) === 0;

  async function createAndFocus(initialCells: Record<string, CellValue> = {}) {
    const created = await createRow.mutateAsync({ cells: initialCells });
    setPendingFocusRowId(created.id);
  }

  function clearSelection() {
    setSelectedRowIds(new Set());
  }

  function bulkSetCell(columnId: string, value: CellValue) {
    const ids = Array.from(selectedRowIds);
    Promise.all(
      ids.map((rowId) =>
        updateRow.mutateAsync({
          rowId,
          update: { cells: { [columnId]: value } },
        }),
      ),
    ).catch(() => {});
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {titleEditing ? (
            <input
              ref={titleRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setTitleDraft(table.name);
                  setTitleEditing(false);
                }
              }}
              className="w-full min-w-0 text-[32px] leading-tight font-bold tracking-tight bg-transparent outline-none"
            />
          ) : (
            <h1
              onClick={() => setTitleEditing(true)}
              className="min-w-0 text-[32px] leading-tight font-bold tracking-tight cursor-text rounded -mx-1 px-1 hover:bg-foreground/[0.03]"
            >
              {table.name}
            </h1>
          )}
          <FilePathLine className="mt-1.5" />
        </div>
        <DeleteTableButton
          onConfirm={() =>
            removeTable.mutate(
              { id: table.id },
              { onSuccess: () => navigate({ replace: true, to: "/databases" }) },
            )
          }
        />
      </div>

      <div className="flex items-center justify-between gap-2 -mx-1 mb-2 border-b border-border/50 pb-1">
        <ViewTabs
          views={table.views}
          activeId={activeView.id}
          onSelect={setActiveViewId}
          onAdd={addView}
          onRename={(id, name) => patchView(id, { name })}
          onDelete={deleteView}
        />
      </div>

      <div className="flex items-center flex-wrap gap-1.5 mb-3">
        <FilterControl
          columns={table.columns}
          filters={activeView.filters}
          onChange={(filters) => patchView(activeView.id, { filters })}
        />
        <SortControl
          columns={table.columns}
          sorts={activeView.sorts ?? []}
          onChange={(sorts) => patchView(activeView.id, { sorts })}
        />
        {activeView.type === "board" && (
          <BoardGroupByControl
            columns={table.columns}
            value={activeView.group_by ?? null}
            onChange={(group_by) => patchView(activeView.id, { group_by })}
          />
        )}
        {activeView.type === "calendar" && (
          <CalendarDateControl
            columns={table.columns}
            value={activeView.group_by ?? null}
            onChange={(group_by) => patchView(activeView.id, { group_by })}
          />
        )}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={showAllInView}
            className="h-7 px-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
          >
            {hiddenCount} hidden — show all
          </button>
        )}
      </div>

      {/* Reserve the bulk-action bar's height in table view at all times so
          selecting a row slides the bar into a fixed slot instead of pushing
          the table down. Board/calendar views don't have row selection, so
          they get no reserved gap. */}
      {activeView.type === "table" && (
        <div className="mb-2 h-9">
          {selectedRowIds.size > 0 && (
            <BulkActionBar
              count={selectedRowIds.size}
              columns={table.columns}
              onClear={clearSelection}
              onDelete={bulkDeleteSelected}
              onSetCell={bulkSetCell}
            />
          )}
        </div>
      )}

      {activeView.type === "board" ? (
        <BoardView
          table={table}
          rows={visibleRows}
          view={activeView}
          onCellChange={(rowId, colId, value) =>
            updateRow.mutate({
              rowId,
              update: { cells: { [colId]: value } },
            })
          }
          onAddRow={(initialCells) => createRow.mutate({ cells: initialCells })}
        />
      ) : activeView.type === "calendar" ? (
        <CalendarView
          table={table}
          rows={visibleRows}
          view={activeView}
          onAddRow={(initialCells) => createRow.mutate({ cells: initialCells })}
        />
      ) : activeView.type === "gallery" ? (
        <GalleryView table={table} rows={visibleRows} />
      ) : activeView.type === "list" ? (
        <ListView table={table} rows={visibleRows} />
      ) : (
      <TableGrid
        table={table}
        rows={visibleRows}
        view={activeView}
        visibleColumns={visibleColumns}
        titleColumnId={titleColumnId}
        pendingFocusRowId={pendingFocusRowId}
        selectedRowIds={selectedRowIds}
        onSelectAll={setSelectedRowIds}
        onToggleRow={(rowId) =>
          setSelectedRowIds((prev) => {
            const next = new Set(prev);
            if (next.has(rowId)) next.delete(rowId);
            else next.add(rowId);
            return next;
          })
        }
        onReorderColumn={reorderColumn}
        onRenameColumn={renameColumn}
        onChangeColumnType={changeColumnType}
        onHideColumn={hideColumnInView}
        onDeleteColumn={deleteColumn}
        onResizeColumn={resizeColumn}
        onPatchColumn={patchColumn}
        onAddColumn={addColumn}
        onAddRow={() => createAndFocus()}
        onAddOption={addOption}
        onUpdateCell={(rowId, colId, value) =>
          updateRow.mutate({
            rowId,
            update: { cells: { [colId]: value } },
          })
        }
        onSetCalculation={setCalculation}
        canManuallyOrderRows={canManuallyOrderRows}
        onReorderRows={(rowIds) => reorderRows.mutate({ rowIds })}
      />
      )}

      {visibleRows.length === 0 && rows.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground italic">
          No rows match the current filter.
        </p>
      )}
    </div>
  );
}

function defaultColumnName(index: number, type: ColumnType): string {
  if (index === 0) return "Name";
  return `${type[0].toUpperCase()}${type.slice(1)} ${index + 1}`;
}

function minWidthForName(name: string, isTitleColumn: boolean): number {
  const chrome = isTitleColumn ? 56 : 36;
  const textPx = name.length * 7;
  return Math.max(60, chrome + textPx);
}

interface TableGridProps {
  table: TableDto;
  rows: RowDto[];
  view: ViewDto;
  visibleColumns: ColumnDto[];
  titleColumnId: string | undefined;
  pendingFocusRowId: string | null;
  selectedRowIds: Set<string>;
  onSelectAll: (next: Set<string>) => void;
  onToggleRow: (rowId: string) => void;
  onReorderColumn: (activeId: string, overId: string) => void;
  onRenameColumn: (colId: string, name: string) => void;
  onChangeColumnType: (colId: string, type: ColumnType) => void;
  onHideColumn: (colId: string) => void;
  onDeleteColumn: (colId: string) => void;
  onResizeColumn: (colId: string, width: number) => void;
  onPatchColumn: (colId: string, patch: Partial<ColumnDto>) => void;
  onAddColumn: (type: ColumnType) => void;
  onAddRow: () => void;
  onAddOption: (colId: string, option: SelectOption) => void;
  onUpdateCell: (rowId: string, colId: string, value: CellValue) => void;
  onSetCalculation: (colId: string, fn: CalcFn | null) => void;
  canManuallyOrderRows: boolean;
  onReorderRows: (rowIds: string[]) => void;
}

/**
 * CSS Grid-based table renderer. Each row is its own grid that references
 * `--col-grid` from the wrapper, so all rows align without us re-emitting
 * the template per row. Resize mutates `--col-grid` directly during drag
 * for live feedback (no React re-renders), then commits on release.
 *
 * Layout: `[checkbox 32px] [data cols ...] [1fr spacer] [add-col 40px]`
 * The `1fr` absorbs leftover so the table spans the page even with few cols.
 */
function TableGrid({
  table,
  rows,
  view,
  visibleColumns,
  titleColumnId,
  pendingFocusRowId,
  selectedRowIds,
  onSelectAll,
  onToggleRow,
  onReorderColumn,
  onRenameColumn,
  onChangeColumnType,
  onHideColumn,
  onDeleteColumn,
  onResizeColumn,
  onPatchColumn,
  onAddColumn,
  onAddRow,
  onAddOption,
  onUpdateCell,
  onSetCalculation,
  canManuallyOrderRows,
  onReorderRows,
}: TableGridProps) {
  // TanStack column defs. Two synthetic columns wrap the user data:
  //   __select  (leading 32px checkbox)
  //   <user data columns> — resizable, sized from schema
  //   __addcol  (trailing 40px add-column button)
  // Cell/header bodies render directly with our existing components; the
  // table primitive only provides sizing + the resize-handle plumbing.
  const tanstackColumns = useMemo<ColumnDef<RowDto>[]>(() => {
    const select: ColumnDef<RowDto> = {
      id: "__select",
      size: 36,
      enableResizing: false,
    };
    const addCol: ColumnDef<RowDto> = {
      id: "__addcol",
      size: 40,
      enableResizing: false,
    };
    const data: ColumnDef<RowDto>[] = visibleColumns.map((col, idx) => ({
      id: col.id,
      accessorFn: (row) => row.cells[col.id],
      size: col.width ?? (idx === 0 ? 240 : 160),
      // Floor of the resize so the header label can't be cropped: type icon
      // (~14px) + gap (6px) + cell horizontal padding (~16px) + the name
      // measured at 12px (≈7px/char). Title column gets a touch more for the
      // doc-icon affordance baked into the body cell.
      minSize: minWidthForName(col.name, idx === 0),
    }));
    return [select, ...data, addCol];
  }, [visibleColumns]);

  const tableInstance = useReactTable({
    data: rows,
    columns: tanstackColumns,
    getCoreRowModel: getCoreRowModel(),
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    // Commit the new width to the schema only when the drag ends. Each
    // pointer move updates TanStack's internal `columnSizing` state — and
    // hence our `--col-*-size` CSS variables for live feedback — but we
    // skip the round-trip to disk until the user releases.
    onColumnSizingInfoChange: (updater) => {
      const prev = sizingInfoRef.current;
      const next = typeof updater === "function" ? updater(prev) : updater;
      sizingInfoRef.current = next;
      if (prev.isResizingColumn && !next.isResizingColumn) {
        const colId = prev.isResizingColumn;
        const sizing = tableInstance.getState().columnSizing;
        const w = sizing[colId];
        if (typeof colId === "string" && typeof w === "number") {
          onResizeColumn(colId, w);
        }
      }
    },
  });
  const sizingInfoRef = useRef<ColumnSizingInfoState>(
    tableInstance.getState().columnSizingInfo,
  );

  // CSS variables for header and data-cell widths. Recomputed any time
  // `columnSizingInfo` (live drag width) or `columnSizing` (committed widths)
  // change. Each cell consumes `var(--col-<id>-size)` so live drags reflow
  // the whole table off a single style mutation on the wrapper.
  const columnSizeVars = useMemo(() => {
    const headers = tableInstance.getFlatHeaders();
    const sizes: Record<string, string> = {};
    for (const header of headers) {
      sizes[`--col-${header.column.id}-size`] = `${header.getSize()}px`;
    }
    return sizes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tableInstance.getState().columnSizingInfo,
    tableInstance.getState().columnSizing,
    visibleColumns,
  ]);

  const headers = tableInstance.getHeaderGroups()[0]?.headers ?? [];
  const dataHeaders = headers.filter(
    (h) => h.column.id !== "__select" && h.column.id !== "__addcol",
  );
  const tableBodyRows = tableInstance.getRowModel().rows;

  return (
    <div
      className="w-full min-h-[240px]"
      style={columnSizeVars as React.CSSProperties}
    >
      <ColumnsDnd
        tableId={table.id}
        ids={visibleColumns.map((c) => c.id)}
        onReorder={onReorderColumn}
      >
        <div className="min-w-full" style={{ width: "max-content" }}>
          {/* Header row */}
          <Row className="group border-b border-border/60 h-8">
            <HeaderShell header={headers[0]}>
              <SelectAllCheckbox
                rowIds={rows.map((r) => r.id)}
                selected={selectedRowIds}
                onChange={onSelectAll}
              />
            </HeaderShell>
            {dataHeaders.map((header, idx) => {
              const col = visibleColumns[idx];
              if (!col) return null;
              return (
                <SortableHeaderCell
                  key={header.id}
                  header={header}
                  column={col}
                  isFirst={idx === 0}
                  currentCalc={view.calculations?.[col.id] ?? null}
                  onRename={(name) => onRenameColumn(col.id, name)}
                  onChangeType={(t) => onChangeColumnType(col.id, t)}
                  onHide={() => onHideColumn(col.id)}
                  onDelete={() => onDeleteColumn(col.id)}
                  onPatch={(patch) => onPatchColumn(col.id, patch)}
                  onSetCalculation={(fn) => onSetCalculation(col.id, fn)}
                  canDelete={table.columns.length > 1}
                />
              );
            })}
            {/* spacer absorbs leftover so the table fills the panel */}
            <div className="flex-1" />
            <HeaderShell header={headers[headers.length - 1]}>
              <AddColumnButton onAdd={onAddColumn} />
            </HeaderShell>
          </Row>

          <RowsDnd
            tableId={table.id}
            ids={tableBodyRows.map((rowModel) => rowModel.original.id)}
            enabled={canManuallyOrderRows}
            onReorder={onReorderRows}
          >
            {tableBodyRows.map((rowModel) => {
              const row = rowModel.original;
              const isSelected = selectedRowIds.has(row.id);
              const anySelected = selectedRowIds.size > 0;
              const cells = rowModel.getVisibleCells();
              const dataCells = cells.filter(
                (c) =>
                  c.column.id !== "__select" && c.column.id !== "__addcol",
              );
              return (
                <SortableTableRow
                  key={row.id}
                  rowId={row.id}
                  enabled={canManuallyOrderRows}
                  className={`group border-b border-border/40 transition-colors ${
                    isSelected ? "bg-accent/30" : "hover:bg-muted/15"
                  }`}
                >
                  {(dragHandle) => (
                    <>
                      <CellShell
                        columnId="__select"
                        className="px-1 flex items-center justify-center"
                      >
                        <RowSelectCell
                          rowId={row.id}
                          isSelected={isSelected}
                          anySelected={anySelected}
                          onToggle={() => onToggleRow(row.id)}
                          dragHandle={dragHandle}
                        />
                      </CellShell>
                      {dataCells.map((cellModel, idx) => {
                  const col = visibleColumns[idx];
                  if (!col) return null;
                  return (
                    <CellShell
                      key={cellModel.id}
                      columnId={col.id}
                      className={`flex items-center min-h-9 border-r border-border/40 ${
                        idx === 0 ? "pl-1 pr-2.5" : "px-2.5"
                      }`}
                    >
                      {idx === 0 && col.type === "text" ? (
                        <div className="relative flex items-center gap-1.5 min-w-0 w-full">
                          <Link
                            to="/databases/$id/$rowId"
                            params={{ id: table.id, rowId: row.id }}
                            aria-label="Open row"
                            className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-foreground/[0.05] shrink-0 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <FileText className="h-3.5 w-3.5" />
                          </Link>
                          <div className="min-w-0 flex-1">
                            <Cell
                              column={col}
                              value={row.cells[col.id] as CellValue | undefined}
                              autoFocus={
                                col.id === titleColumnId &&
                                row.id === pendingFocusRowId
                              }
                              onCommit={(value) =>
                                onUpdateCell(row.id, col.id, value)
                              }
                            />
                          </div>
                          {/* Notion-style hover affordance, floated over the
                              right edge of the title cell so it doesn't reserve
                              layout width when hidden. */}
                          <Link
                            to="/databases/$id/$rowId"
                            params={{ id: table.id, rowId: row.id }}
                            aria-label="Open row"
                            onClick={(e) => e.stopPropagation()}
                            className="absolute right-0 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                          >
                            <ArrowUpRight className="h-3 w-3" />
                            Open
                          </Link>
                        </div>
                      ) : (
                        <div className="min-w-0 w-full">
                          <Cell
                            column={col}
                            value={row.cells[col.id] as CellValue | undefined}
                            autoFocus={
                              col.id === titleColumnId &&
                              row.id === pendingFocusRowId
                            }
                            onCommit={(value) =>
                              onUpdateCell(row.id, col.id, value)
                            }
                            onCreateOption={
                              col.type === "select" || col.type === "multi_select"
                                ? (option) => onAddOption(col.id, option)
                                : undefined
                            }
                          />
                        </div>
                      )}
                    </CellShell>
                  );
                      })}
                      <div className="flex-1" />
                      <CellShell columnId="__addcol" />
                    </>
                  )}
                </SortableTableRow>
              );
            })}
          </RowsDnd>

          {/* + New item row */}
          <Row className="border-b border-border/40 h-9">
            <CellShell columnId="__select" />
            <div className="flex-1 flex items-center px-2.5">
              <button
                type="button"
                onClick={onAddRow}
                className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                New item
              </button>
            </div>
          </Row>

          {hasAnyCalculation(view) && (
            <Row>
              <CellShell columnId="__select" />
              {dataHeaders.map((header, idx) => {
                const col = visibleColumns[idx];
                if (!col) return null;
                return (
                  <CellShell
                    key={header.id}
                    columnId={col.id}
                    className="px-2.5 pt-2 pb-3 flex items-center border-r border-border/40"
                  >
                    <CalculationCell
                      column={col}
                      rows={rows}
                      fn={view.calculations?.[col.id] ?? null}
                      onChange={(fn) => onSetCalculation(col.id, fn)}
                    />
                  </CellShell>
                );
              })}
              <div className="flex-1" />
              <CellShell columnId="__addcol" />
            </Row>
          )}
        </div>
      </ColumnsDnd>
    </div>
  );
}

/** Flex row used for header / body / footer / new-item rows alike. */
function Row({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={`flex items-stretch ${className}`}>{children}</div>;
}

/** Body cell sized via the per-column CSS variable set by TanStack. */
function CellShell({
  columnId,
  className = "",
  children,
}: {
  columnId: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      data-table-cell=""
      className={`shrink-0 min-w-0 ${className}`}
      style={{ width: `var(--col-${columnId}-size)` }}
    >
      {children}
    </div>
  );
}

/** Header cell wrapper for the leading/trailing synthetic columns. */
function HeaderShell({
  header,
  children,
}: {
  header: Header<RowDto, unknown> | undefined;
  children?: React.ReactNode;
}) {
  if (!header) return null;
  return (
    <div
      className="shrink-0 min-w-0 px-1 flex items-center justify-center"
      style={{ width: `var(--col-${header.column.id}-size)` }}
    >
      {children}
    </div>
  );
}

function applyView(
  rows: RowDto[],
  columns: ColumnDto[],
  view: ViewDto,
): RowDto[] {
  let out = rows;
  const filters = view.filters;
  if (filters && filters.conditions.length > 0) {
    const op = filters.op;
    out = out.filter((row) => {
      const evaluations = filters.conditions.map((cond) =>
        evaluateCondition(row, cond, columns),
      );
      return op === "or"
        ? evaluations.some(Boolean)
        : evaluations.every(Boolean);
    });
  }
  const sorts = view.sorts ?? [];
  if (sorts.length > 0) {
    out = [...out].sort((a, b) => {
      for (const s of sorts) {
        const col = columns.find((c) => c.id === s.column);
        if (!col) continue;
        const cmp = compareCells(a, b, col, s.direction);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }
  return out;
}

function evaluateCondition(
  row: RowDto,
  filter: { column: string; op: string; value?: unknown },
  columns: ColumnDto[],
): boolean {
  const col = columns.find((c) => c.id === filter.column);
  if (!col) return true;
  const v = row.cells[filter.column];
  // Multi-select: cell is string[]; "contains"/"not_contains" check membership.
  if (col.type === "multi_select") {
    const arr = Array.isArray(v) ? v : [];
    switch (filter.op) {
      case "contains":
        return arr.includes(String(filter.value ?? ""));
      case "not_contains":
        return !arr.includes(String(filter.value ?? ""));
      case "is_empty":
        return arr.length === 0;
      default:
        return true;
    }
  }
  switch (filter.op) {
    case "is_empty":
      return v === null || v === undefined || v === "";
    case "is_checked":
      return v === true;
    case "is_unchecked":
      return v !== true;
    case "is":
    case "eq":
    case "on":
      return String(v ?? "") === String(filter.value ?? "");
    case "is_not":
    case "neq":
      return String(v ?? "") !== String(filter.value ?? "");
    case "contains":
      return String(v ?? "")
        .toLowerCase()
        .includes(String(filter.value ?? "").toLowerCase());
    case "gt":
      return typeof v === "number" && typeof filter.value === "number" && v > filter.value;
    case "lt":
      return typeof v === "number" && typeof filter.value === "number" && v < filter.value;
    case "before":
      return typeof v === "string" && typeof filter.value === "string" && v < filter.value;
    case "after":
      return typeof v === "string" && typeof filter.value === "string" && v > filter.value;
    default:
      return true;
  }
}

function compareCells(
  a: RowDto,
  b: RowDto,
  col: ColumnDto,
  dir: "asc" | "desc",
): number {
  const av = a.cells[col.id];
  const bv = b.cells[col.id];
  // Empty values always sort to the bottom regardless of direction; matches
  // Notion's convention so a sort doesn't drag empty cells to the top.
  const aEmpty = av === null || av === undefined || av === "";
  const bEmpty = bv === null || bv === undefined || bv === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  let cmp: number;
  if (col.type === "number") {
    cmp = (Number(av) || 0) - (Number(bv) || 0);
  } else if (col.type === "checkbox") {
    cmp = (av === true ? 1 : 0) - (bv === true ? 1 : 0);
  } else if (col.type === "select") {
    // Sort selects by option order (definition order in column.options).
    const order = (col.options ?? []).map((o) => o.id);
    cmp = order.indexOf(String(av)) - order.indexOf(String(bv));
  } else if (col.type === "multi_select") {
    // Sort multi-select by the *first* option's order — matches Notion's
    // "primary tag" behavior. Empty arrays already handled above.
    const order = (col.options ?? []).map((o) => o.id);
    const aFirst = Array.isArray(av) && av.length > 0 ? String(av[0]) : "";
    const bFirst = Array.isArray(bv) && bv.length > 0 ? String(bv[0]) : "";
    cmp = order.indexOf(aFirst) - order.indexOf(bFirst);
  } else {
    cmp = String(av).localeCompare(String(bv));
  }
  return dir === "asc" ? cmp : -cmp;
}

function CalculationCell({
  column,
  rows,
  fn,
  onChange,
}: {
  column: ColumnDto;
  rows: RowDto[];
  fn: CalcFn | null;
  onChange: (fn: CalcFn | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Only number columns support sum/avg/min/max; everything else only allows count.
  const allowed: CalcFn[] =
    column.type === "number"
      ? ["sum", "count", "avg", "min", "max"]
      : ["count"];

  const display = fn ? computeCalculation(rows, column, fn) : null;
  const fnLabel = fn ? CALC_FNS.find((c) => c.value === fn)?.label : null;

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`block w-full text-right text-[12px] ${
          fn
            ? "text-foreground"
            : "text-muted-foreground/50 hover:text-muted-foreground opacity-0 hover:opacity-100 transition-opacity"
        }`}
      >
        {fn ? (
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
              {fnLabel}
            </span>
            <span className="tabular-nums font-medium">{display}</span>
          </span>
        ) : (
          <span>Calculate</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 bottom-full z-50 mb-1 w-40 rounded-md border border-border bg-popover shadow-md p-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onChange(null);
            }}
            className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted text-muted-foreground"
          >
            None
          </button>
          {CALC_FNS.filter((c) => allowed.includes(c.value)).map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => {
                setOpen(false);
                onChange(c.value);
              }}
              className="flex items-center justify-between w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
            >
              <span>{c.label}</span>
              {fn === c.value && <span className="text-xs">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function computeCalculation(
  rows: RowDto[],
  column: ColumnDto,
  fn: CalcFn,
): string {
  if (fn === "count") {
    return String(
      rows.filter((r) => {
        const v = r.cells[column.id];
        return v !== null && v !== undefined && v !== "";
      }).length,
    );
  }
  const numbers = rows
    .map((r) => r.cells[column.id])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (numbers.length === 0) return "—";
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  let result: number;
  switch (fn) {
    case "sum":
      result = sum;
      break;
    case "avg":
      result = sum / numbers.length;
      break;
    case "min":
      result = Math.min(...numbers);
      break;
    case "max":
      result = Math.max(...numbers);
      break;
    default:
      return "—";
  }
  // Reuse the column's number format/precision so SUM / AVG read the same
  // style as the cells above ($800.00 stays $800.00 instead of plain 800).
  return formatNumber(result, column.format ?? "number", column.precision);
}

function AddColumnButton({
  onAdd,
}: {
  onAdd: (type: ColumnType) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add column"
        className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05]"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-popover shadow-md p-1">
          {(
            ["text", "number", "select", "multi_select", "checkbox", "date"] as ColumnType[]
          ).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setOpen(false);
                onAdd(t);
              }}
              className="flex items-center gap-2 w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
            >
              <ColumnTypeIcon type={t} />
              <span>{columnTypeLabel(t)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BoardGroupByControl({
  columns,
  value,
  onChange,
}: {
  columns: ColumnDto[];
  value: string | null;
  onChange: (group_by: string | null) => void;
}) {
  const groupable = columns.filter(
    (c) => c.type === "select" || c.type === "multi_select",
  );
  if (groupable.length === 0) {
    return (
      <span className="h-7 px-2 inline-flex items-center text-[12px] text-muted-foreground">
        Add a select column to group by
      </span>
    );
  }
  return (
    <label className="flex items-center gap-1 h-7 px-1.5 rounded-sm bg-muted/40 border border-border/60 text-[13px]">
      <span className="text-muted-foreground">Group by</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="bg-transparent text-foreground/80 outline-none cursor-pointer"
      >
        <option value="">—</option>
        {groupable.map((col) => (
          <option key={col.id} value={col.id}>
            {col.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function CalendarDateControl({
  columns,
  value,
  onChange,
}: {
  columns: ColumnDto[];
  value: string | null;
  onChange: (group_by: string | null) => void;
}) {
  const dateCols = columns.filter((c) => c.type === "date");
  if (dateCols.length === 0) {
    return (
      <span className="h-7 px-2 inline-flex items-center text-[12px] text-muted-foreground">
        Add a date column to use this view
      </span>
    );
  }
  return (
    <label className="flex items-center gap-1 h-7 px-1.5 rounded-sm bg-muted/40 border border-border/60 text-[13px]">
      <span className="text-muted-foreground">Date</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="bg-transparent text-foreground/80 outline-none cursor-pointer"
      >
        <option value="">—</option>
        {dateCols.map((col) => (
          <option key={col.id} value={col.id}>
            {col.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Wraps the table grid in dnd-kit Sortable context so column headers can
 * be dragged horizontally to reorder. We hand it a stable `id` keyed on the
 * table id so SSR/CSR don't drift on the auto-generated `aria-describedby`
 * (the same hydration trap that bit task-sidebar earlier).
 */
function ColumnsDnd({
  tableId,
  ids,
  onReorder,
  children,
}: {
  tableId: string;
  ids: string[];
  onReorder: (activeId: string, overId: string) => void;
  children: React.ReactNode;
}) {
  // 4px activation threshold matches task-sidebar — clicks on the header
  // popover button shouldn't kick off a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    onReorder(String(active.id), String(over.id));
  }
  return (
    <DndContext
      id={`table-columns-${tableId}`}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/**
 * Row ordering is only available in an unfiltered, unsorted table view so
 * the persisted order always corresponds to the complete row collection.
 */
function RowsDnd({
  tableId,
  ids,
  enabled,
  onReorder,
  children,
}: {
  tableId: string;
  ids: string[];
  enabled: boolean;
  onReorder: (rowIds: string[]) => void;
  children: React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = moveTableRowIds(ids, String(active.id), String(over.id));
    if (next) onReorder(next);
  }
  if (!enabled) return <>{children}</>;
  return (
    <DndContext
      id={`table-rows-${tableId}`}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

function SortableTableRow({
  rowId,
  enabled,
  className,
  children,
}: {
  rowId: string;
  enabled: boolean;
  className: string;
  children: (dragHandle: React.ReactNode) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rowId, disabled: !enabled });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const dragHandle = enabled ? (
    <span
      {...attributes}
      {...listeners}
      aria-label="Reorder row"
      title="Drag to reorder"
      className="-ml-1 mr-1 inline-flex h-5 w-3 shrink-0 cursor-grab items-center justify-center text-muted-foreground/55 opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing group-hover:opacity-100 focus-visible:opacity-100"
    >
      <GripVertical className="h-3.5 w-3.5" />
    </span>
  ) : null;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-stretch ${className}`}
    >
      {children(dragHandle)}
    </div>
  );
}

/**
 * Header cell for a data column. Width comes from the TanStack header
 * (which carries the live size during a resize via `--col-<id>-size`).
 * Reorder via dnd-kit's left-edge handle, resize via TanStack's right-edge
 * handle. Both fall through to clicking the header itself to open its
 * type/format/etc. popover.
 */
function SortableHeaderCell({
  header,
  column,
  isFirst,
  currentCalc,
  onRename,
  onChangeType,
  onHide,
  onDelete,
  onPatch,
  onSetCalculation,
  canDelete,
}: {
  header: Header<RowDto, unknown>;
  column: ColumnDto;
  isFirst: boolean;
  currentCalc: CalcFn | null;
  onRename: (name: string) => void;
  onChangeType: (t: ColumnType) => void;
  onHide: () => void;
  onDelete: () => void;
  onPatch: (patch: Partial<ColumnDto>) => void;
  onSetCalculation: (fn: CalcFn | null) => void;
  canDelete: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: column.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    width: `var(--col-${column.id}-size)`,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group/header shrink-0 min-w-0 text-left font-normal relative h-8 ${
        isFirst ? "pl-2.5 pr-2.5" : "px-2.5"
      } flex items-center`}
    >
      {/* Drag handle: thin invisible strip on the left edge. Clicking the
          header (popover) still works because the handle covers only a few
          pixels. */}
      <span
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${column.name}`}
        className="absolute inset-y-0 left-0 w-1.5 cursor-grab active:cursor-grabbing z-10"
      />
      <ColumnHeader
        column={column}
        onRename={onRename}
        onChangeType={onChangeType}
        onHide={onHide}
        onDelete={onDelete}
        onPatch={onPatch}
        currentCalc={currentCalc}
        onSetCalculation={onSetCalculation}
        canDelete={canDelete}
      />
      {header.column.getCanResize() && (
        <span
          onMouseDown={header.getResizeHandler()}
          onTouchStart={header.getResizeHandler()}
          aria-label="Resize column"
          title="Drag to resize column"
          role="separator"
          className={`group/resize absolute top-0 -right-1.5 z-20 h-full w-3 touch-none select-none cursor-col-resize ${
            header.column.getIsResizing() ? "bg-foreground/40" : ""
          }`}
        >
          <span className="absolute inset-y-1 left-1/2 -translate-x-1/2 w-px bg-foreground/0 transition-colors group-hover/header:bg-foreground/20 group-hover/resize:bg-foreground/50" />
        </span>
      )}
    </div>
  );
}

function hasAnyCalculation(view: ViewDto): boolean {
  const c = view.calculations;
  return !!c && Object.keys(c).length > 0;
}

function RowSelectCell({
  rowId,
  isSelected,
  anySelected,
  onToggle,
  dragHandle,
}: {
  rowId: string;
  isSelected: boolean;
  anySelected: boolean;
  onToggle: () => void;
  dragHandle?: React.ReactNode;
}) {
  // The checkbox is the only affordance in the leading column. It's hidden
  // until the row is hovered (or until the user is already in selection mode,
  // in which case all checkboxes stay visible).
  const alwaysShow = anySelected || isSelected;
  return (
    <div data-row-id={rowId} className="flex items-center justify-center gap-px">
      {dragHandle}
      <span
        className={
          alwaysShow
            ? ""
            : "opacity-0 group-hover:opacity-100 transition-opacity"
        }
      >
        <Checkbox checked={isSelected} onChange={onToggle} />
      </span>
    </div>
  );
}

function SelectAllCheckbox({
  rowIds,
  selected,
  onChange,
}: {
  rowIds: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const visibleSelectedCount = rowIds.filter((id) => selected.has(id)).length;
  const allChecked = rowIds.length > 0 && visibleSelectedCount === rowIds.length;
  const someChecked = visibleSelectedCount > 0 && !allChecked;

  function toggleAll() {
    if (allChecked) {
      onChange(new Set());
    } else {
      onChange(new Set(rowIds));
    }
  }

  if (rowIds.length === 0) return null;
  // Hide until the user is in selection mode or hovers the header — keeps
  // the empty header clean when nobody's selecting.
  return (
    <div className="flex items-center justify-center">
      <span
        className={
          selected.size > 0
            ? ""
            : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
        }
      >
        <Checkbox
          checked={allChecked}
          indeterminate={someChecked}
          onChange={toggleAll}
        />
      </span>
    </div>
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
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      // Outline via an inset ring (box-shadow) rather than a `border`: a 14px
      // transparent box with a 1px border + radius + transition intermittently
      // drops its bottom/right edges in WKWebView (the broken "⌐" render). A
      // box-shadow paints as one shape and doesn't.
      className={`h-3.5 w-3.5 rounded-sm ring-1 ring-inset flex items-center justify-center transition-colors ${
        checked || indeterminate
          ? "bg-foreground ring-foreground"
          : "bg-transparent ring-muted-foreground/40 hover:ring-foreground/70"
      }`}
    >
      {indeterminate ? (
        <span className="block h-[2px] w-2 bg-background" />
      ) : checked ? (
        <CheckIcon />
      ) : null}
    </button>
  );
}

function CheckIcon() {
  return (
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
  );
}

function BulkActionBar({
  count,
  columns,
  onClear,
  onDelete,
  onSetCell,
}: {
  count: number;
  columns: ColumnDto[];
  onClear: () => void;
  onDelete: () => void;
  onSetCell: (columnId: string, value: CellValue) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-center gap-2 -mx-1 px-2 h-9 rounded-md bg-accent/50 border border-border/60 text-[13px]">
      <span className="font-medium">
        {count} {count === 1 ? "row" : "rows"} selected
      </span>
      <div className="h-4 w-px bg-border/60" />
      <BulkEditMenu columns={columns} onSetCell={onSetCell} />
      {confirming ? (
        <div className="flex items-center gap-1.5 ml-auto">
          <span className="text-muted-foreground">Delete {count}?</span>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
            className="h-7 px-2 rounded-sm bg-foreground text-background text-[12px]"
          >
            Yes, delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="h-7 px-2 rounded-sm border border-border text-[12px] hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="ml-auto h-7 px-2 inline-flex items-center gap-1 text-[12px] text-foreground hover:bg-foreground/[0.05] rounded-sm transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      )}
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className="h-7 w-7 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05]"
      >
        ×
      </button>
    </div>
  );
}

function BulkEditMenu({
  columns,
  onSetCell,
}: {
  columns: ColumnDto[];
  onSetCell: (columnId: string, value: CellValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeColumn, setActiveColumn] = useState<ColumnDto | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveColumn(null);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Only column types that have a deterministic "single value" make sense
  // for bulk edit. Text bulk-edit is intentionally skipped (overwriting many
  // names/titles is rarely intentional), but checkbox/select/date are.
  const editable = columns.filter(
    (c) =>
      c.type === "select" ||
      c.type === "checkbox" ||
      c.type === "date" ||
      c.type === "number",
  );

  if (editable.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-7 px-2 text-[12px] text-foreground hover:bg-foreground/[0.05] rounded-sm transition-colors"
      >
        Edit field…
      </button>
      {open && !activeColumn && (
        <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-popover shadow-md p-1">
          {editable.map((col) => (
            <button
              key={col.id}
              type="button"
              onClick={() => setActiveColumn(col)}
              className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
            >
              {col.name}
            </button>
          ))}
        </div>
      )}
      {open && activeColumn && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover shadow-md p-2 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Set {activeColumn.name} to
          </div>
          <BulkValuePicker
            column={activeColumn}
            onPick={(v) => {
              setOpen(false);
              setActiveColumn(null);
              onSetCell(activeColumn.id, v);
            }}
          />
          <button
            type="button"
            onClick={() => setActiveColumn(null)}
            className="block w-full px-2 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
          >
            ← back
          </button>
        </div>
      )}
    </div>
  );
}

function BulkValuePicker({
  column,
  onPick,
}: {
  column: ColumnDto;
  onPick: (v: CellValue) => void;
}) {
  if (column.type === "checkbox") {
    return (
      <div className="space-y-1">
        <button
          type="button"
          onClick={() => onPick(true)}
          className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
        >
          Checked
        </button>
        <button
          type="button"
          onClick={() => onPick(false)}
          className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
        >
          Unchecked
        </button>
      </div>
    );
  }
  if (column.type === "select") {
    return (
      <div className="space-y-1">
        {(column.options ?? []).map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onPick(opt.id)}
            className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
          >
            {opt.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onPick(null)}
          className="block w-full px-2 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      </div>
    );
  }
  if (column.type === "number") {
    return <BulkInput type="number" onPick={onPick} />;
  }
  if (column.type === "date") {
    return <BulkInput type="date" onPick={onPick} />;
  }
  return null;
}

function BulkInput({
  type,
  onPick,
}: {
  type: "number" | "date";
  onPick: (v: CellValue) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft) {
          onPick(null);
          return;
        }
        if (type === "number") {
          const n = Number(draft);
          if (Number.isFinite(n)) onPick(n);
        } else {
          onPick(draft);
        }
      }}
      className="flex items-center gap-1"
    >
      <input
        autoFocus
        type={type}
        step={type === "number" ? "any" : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="flex-1 px-2 h-7 text-[13px] rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      <button
        type="submit"
        className="h-7 px-2 rounded-sm bg-foreground text-background text-[12px]"
      >
        Set
      </button>
    </form>
  );
}

function DeleteTableButton({ onConfirm }: { onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground">Delete this table?</span>
        <button
          type="button"
          onClick={onConfirm}
          className="h-7 px-3 rounded-sm bg-accent text-accent-foreground text-[13px]"
        >
          Yes, delete
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
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
      onClick={() => setConfirming(true)}
      aria-label="Delete table"
      className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] shrink-0"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}
