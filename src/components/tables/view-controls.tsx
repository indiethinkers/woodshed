import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type {
  CellValue,
  ColumnDto,
  ColumnType,
  FilterCombineOp,
  ViewDto,
  ViewFilter,
  ViewFilters,
  ViewSort,
} from "@/lib/hooks/use-tables";

const FILTER_OPS: Record<ColumnType, { label: string; value: string }[]> = {
  text: [
    { label: "contains", value: "contains" },
    { label: "is", value: "is" },
    { label: "is empty", value: "is_empty" },
  ],
  number: [
    { label: "=", value: "eq" },
    { label: "≠", value: "neq" },
    { label: ">", value: "gt" },
    { label: "<", value: "lt" },
    { label: "is empty", value: "is_empty" },
  ],
  select: [
    { label: "is", value: "is" },
    { label: "is not", value: "is_not" },
    { label: "is empty", value: "is_empty" },
  ],
  multi_select: [
    { label: "contains", value: "contains" },
    { label: "doesn't contain", value: "not_contains" },
    { label: "is empty", value: "is_empty" },
  ],
  checkbox: [
    { label: "is checked", value: "is_checked" },
    { label: "is unchecked", value: "is_unchecked" },
  ],
  date: [
    { label: "on", value: "on" },
    { label: "before", value: "before" },
    { label: "after", value: "after" },
    { label: "is empty", value: "is_empty" },
  ],
};

interface FilterControlProps {
  columns: ColumnDto[];
  filters: ViewFilters | undefined;
  onChange: (filters: ViewFilters) => void;
}

export function FilterControl({ columns, filters, onChange }: FilterControlProps) {
  const conditions = filters?.conditions ?? [];
  const op = filters?.op ?? "and";

  function addCondition(col: ColumnDto) {
    const ops = FILTER_OPS[col.type] ?? FILTER_OPS.text;
    onChange({
      op,
      conditions: [
        ...conditions,
        { column: col.id, op: ops[0].value, value: undefined },
      ],
    });
  }

  function updateCondition(idx: number, patch: Partial<ViewFilter>) {
    onChange({
      op,
      conditions: conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    });
  }

  function removeCondition(idx: number) {
    onChange({
      op,
      conditions: conditions.filter((_, i) => i !== idx),
    });
  }

  function setCombineOp(next: FilterCombineOp) {
    onChange({ op: next, conditions });
  }

  return (
    <div className="flex items-center flex-wrap gap-1">
      {conditions.map((cond, idx) => (
        <FilterCondition
          key={idx}
          columns={columns}
          condition={cond}
          combineOp={idx > 0 ? op : null}
          onCombineToggle={
            idx === 1 ? () => setCombineOp(op === "and" ? "or" : "and") : undefined
          }
          onChange={(patch) => updateCondition(idx, patch)}
          onRemove={() => removeCondition(idx)}
        />
      ))}
      <AddFilterButton columns={columns} onPick={addCondition} />
    </div>
  );
}

function FilterCondition({
  columns,
  condition,
  combineOp,
  onCombineToggle,
  onChange,
  onRemove,
}: {
  columns: ColumnDto[];
  condition: ViewFilter;
  combineOp: FilterCombineOp | null;
  /** When provided, this condition is the second one — render the AND/OR
   *  toggle that controls the combine operator for the whole filter group. */
  onCombineToggle?: () => void;
  onChange: (patch: Partial<ViewFilter>) => void;
  onRemove: () => void;
}) {
  const column = columns.find((c) => c.id === condition.column);
  if (!column) {
    return (
      <button
        type="button"
        onClick={onRemove}
        className="h-7 px-2 text-[13px] text-muted-foreground hover:text-foreground"
      >
        Clear stale filter
      </button>
    );
  }
  const ops = FILTER_OPS[column.type] ?? FILTER_OPS.text;
  const showValue = !["is_empty", "is_checked", "is_unchecked"].includes(condition.op);

  return (
    <>
      {combineOp && (
        onCombineToggle ? (
          <button
            type="button"
            onClick={onCombineToggle}
            className="h-7 px-1.5 text-[12px] uppercase tracking-wider text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-sm transition-colors"
          >
            {combineOp}
          </button>
        ) : (
          <span className="h-7 px-1.5 inline-flex items-center text-[12px] uppercase tracking-wider text-muted-foreground">
            {combineOp}
          </span>
        )
      )}
      <div className="flex items-center gap-1 h-7 px-2 rounded-md bg-muted/60 text-[12px]">
        <span className="text-muted-foreground">{column.name}</span>
        <select
          value={condition.op}
          onChange={(e) => onChange({ op: e.target.value })}
          className="bg-transparent text-foreground/80 outline-none cursor-pointer"
        >
          {ops.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {showValue && (
          <FilterValueInput
            column={column}
            value={condition.value}
            onChange={(v) => onChange({ value: v })}
          />
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove condition"
          className="p-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </>
  );
}

function FilterValueInput({
  column,
  value,
  onChange,
}: {
  column: ColumnDto;
  value: unknown;
  onChange: (v: CellValue) => void;
}) {
  if (column.type === "select" || column.type === "multi_select") {
    // Single-select picker for both — multi-select filter checks "contains"
    // against one option at a time; UX matches Notion's "contains" prompt.
    return (
      <select
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="bg-transparent text-foreground outline-none cursor-pointer"
      >
        <option value="">—</option>
        {(column.options ?? []).map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.name}
          </option>
        ))}
      </select>
    );
  }
  if (column.type === "number") {
    return (
      <input
        type="number"
        step="any"
        value={typeof value === "number" ? value : ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
        className="w-20 bg-transparent text-foreground outline-none"
      />
    );
  }
  if (column.type === "date") {
    return (
      <input
        type="date"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="bg-transparent text-foreground outline-none"
      />
    );
  }
  return (
    <input
      type="text"
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder="value"
      className="w-32 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/40"
    />
  );
}

function AddFilterButton({
  columns,
  onPick,
}: {
  columns: ColumnDto[];
  onPick: (col: ColumnDto) => void;
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
        className="flex items-center gap-1 h-7 px-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
      >
        + Filter
      </button>
      {open && (
        <ColumnPicker
          columns={columns}
          onPick={(col) => {
            onPick(col);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

interface SortControlProps {
  columns: ColumnDto[];
  sorts: ViewSort[];
  onChange: (sorts: ViewSort[]) => void;
}

export function SortControl({ columns, sorts, onChange }: SortControlProps) {
  function addSort(col: ColumnDto) {
    if (sorts.some((s) => s.column === col.id)) return;
    onChange([...sorts, { column: col.id, direction: "asc" }]);
  }
  function toggleDir(idx: number) {
    onChange(
      sorts.map((s, i) =>
        i === idx ? { ...s, direction: s.direction === "asc" ? "desc" : "asc" } : s,
      ),
    );
  }
  function removeSort(idx: number) {
    onChange(sorts.filter((_, i) => i !== idx));
  }

  return (
    <div className="flex items-center flex-wrap gap-1">
      {sorts.map((sort, idx) => {
        const col = columns.find((c) => c.id === sort.column);
        if (!col) return null;
        return (
          <div
            key={idx}
            className="flex items-center gap-1 h-7 px-1.5 rounded-sm bg-muted/40 border border-border/60 text-[13px]"
          >
            <span className="text-muted-foreground">{col.name}</span>
            <button
              type="button"
              onClick={() => toggleDir(idx)}
              className="text-foreground/80 cursor-pointer flex items-center gap-0.5"
              aria-label={`Toggle direction (currently ${sort.direction})`}
            >
              {sort.direction === "asc" ? "↑" : "↓"}
            </button>
            <button
              type="button"
              onClick={() => removeSort(idx)}
              aria-label="Remove sort"
              className="p-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <AddSortButton
        columns={columns.filter((c) => !sorts.some((s) => s.column === c.id))}
        onPick={addSort}
      />
    </div>
  );
}

function AddSortButton({
  columns,
  onPick,
}: {
  columns: ColumnDto[];
  onPick: (col: ColumnDto) => void;
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

  if (columns.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 h-7 px-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
      >
        + Sort
      </button>
      {open && (
        <ColumnPicker
          columns={columns}
          onPick={(col) => {
            onPick(col);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ColumnPicker({
  columns,
  onPick,
}: {
  columns: ColumnDto[];
  onPick: (col: ColumnDto) => void;
}) {
  return (
    <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-popover shadow-md p-1">
      {columns.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground italic">
          No columns
        </p>
      ) : (
        columns.map((col) => (
          <button
            key={col.id}
            type="button"
            onClick={() => onPick(col)}
            className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted transition-colors"
          >
            {col.name}
          </button>
        ))
      )}
    </div>
  );
}

type AddableViewType = "table" | "board" | "calendar" | "gallery" | "list";

function viewTypeIcon(type: ViewDto["type"]): string {
  switch (type) {
    case "table":
      return "▤";
    case "board":
      return "▦";
    case "calendar":
      return "📅";
    case "gallery":
      return "▥";
    case "list":
      return "☰";
    default:
      return "▤";
  }
}

interface ViewTabsProps {
  views: ViewDto[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: (type: AddableViewType) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

export function ViewTabs({
  views,
  activeId,
  onSelect,
  onAdd,
  onRename,
  onDelete,
}: ViewTabsProps) {
  return (
    <div className="flex items-center gap-0.5 -mx-1">
      {views.map((view) => (
        <ViewTab
          key={view.id}
          view={view}
          active={view.id === activeId}
          canDelete={views.length > 1}
          onSelect={() => onSelect(view.id)}
          onRename={(name) => onRename(view.id, name)}
          onDelete={() => onDelete(view.id)}
        />
      ))}
      <AddViewButton onAdd={onAdd} />
    </div>
  );
}

function AddViewButton({ onAdd }: { onAdd: (type: AddableViewType) => void }) {
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

  const types: { value: AddableViewType; label: string }[] = [
    { value: "table", label: "Table" },
    { value: "board", label: "Board" },
    { value: "calendar", label: "Calendar" },
    { value: "gallery", label: "Gallery" },
    { value: "list", label: "List" },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ml-1 px-2 h-7 text-[13px] text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
      >
        + Add view
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-popover shadow-md p-1">
          {types.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => {
                setOpen(false);
                onAdd(t.value);
              }}
              className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewTab({
  view,
  active,
  canDelete,
  onSelect,
  onRename,
  onDelete,
}: {
  view: ViewDto;
  active: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(view.name);
  }, [view.name, editing]);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === view.name) {
      setDraft(view.name);
      return;
    }
    onRename(next);
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => {
          if (active) setMenuOpen((v) => !v);
          else onSelect();
        }}
        onDoubleClick={() => {
          if (active) {
            setMenuOpen(false);
            setEditing(true);
          }
        }}
        className={`flex items-center gap-1.5 px-2 h-7 text-[13px] rounded-md transition-colors ${
          active
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
        }`}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(view.name);
                setEditing(false);
              }
            }}
            className="bg-transparent outline-none w-32"
          />
        ) : (
          <>
            <span className="text-muted-foreground/70 text-[11px]">
              {viewTypeIcon(view.type)}
            </span>
            <span>{view.name}</span>
            {active && <ChevronDown className="h-3 w-3 opacity-50" />}
          </>
        )}
      </button>
      {menuOpen && active && !editing && (
        <div className="absolute left-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-popover shadow-md p-1">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setEditing(true);
            }}
            className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
          >
            Rename
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
              className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted text-foreground"
            >
              Delete view
            </button>
          )}
        </div>
      )}
    </div>
  );
}
