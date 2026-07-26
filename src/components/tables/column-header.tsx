import { useEffect, useRef, useState } from "react";
import {
  Calendar,
  CheckSquare,
  Hash,
  ListChecks,
  Tags,
  Type,
} from "lucide-react";
import type {
  CalcFn,
  ColumnDto,
  ColumnType,
  NumberFormat,
} from "@/lib/hooks/use-tables";
import { columnTypeLabel } from "./column-utils";

interface ColumnHeaderProps {
  column: ColumnDto;
  onRename: (name: string) => void;
  onChangeType: (type: ColumnType) => void;
  onHide: () => void;
  onDelete: () => void;
  /** Patches the column with arbitrary fields. Used for number-format and
   *  precision pickers; takes precedence over the lighter onRename/onChangeType
   *  callbacks when both apply. */
  onPatch?: (patch: Partial<ColumnDto>) => void;
  /** Active view's calculation for this column (sum/avg/etc.) and a setter.
   *  Setting calc lives on the view, not the column, so these are wired
   *  separately from the column-mutating callbacks above. */
  currentCalc?: CalcFn | null;
  onSetCalculation?: (fn: CalcFn | null) => void;
  canDelete: boolean;
}
const NUMBER_FORMATS: { value: NumberFormat; label: string; sample: string }[] = [
  { value: "number", label: "Number", sample: "1,200" },
  { value: "us_dollar", label: "US Dollar", sample: "$1,200.00" },
  { value: "euro", label: "Euro", sample: "€1,200.00" },
  { value: "british_pound", label: "British Pound", sample: "£1,200.00" },
  { value: "japanese_yen", label: "Japanese Yen", sample: "¥1,200" },
  { value: "percent", label: "Percent", sample: "12%" },
];

const DECIMAL_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Default" },
  { value: 0, label: "0" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5" },
];

const CALC_OPTIONS: { value: CalcFn | null; label: string }[] = [
  { value: null, label: "None" },
  { value: "sum", label: "Sum" },
  { value: "count", label: "Count" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

export function ColumnHeader({
  column,
  onRename,
  onChangeType,
  onHide,
  onDelete,
  onPatch,
  currentCalc,
  onSetCalculation,
  canDelete,
}: ColumnHeaderProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [submenu, setSubmenu] = useState<
    "format" | "precision" | "calculate" | null
  >(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) setDraft(column.name);
  }, [column.name, renaming]);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function commitRename() {
    setRenaming(false);
    const next = draft.trim();
    if (!next || next === column.name) {
      setDraft(column.name);
      return;
    }
    onRename(next);
  }

  return (
    <div ref={ref} className="relative w-full">
      {renaming ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(column.name);
              setRenaming(false);
            }
          }}
          className="w-full bg-transparent outline-none text-[13px] font-normal"
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 w-full text-left text-[13px] font-normal text-muted-foreground hover:text-foreground transition-colors"
        >
          <ColumnTypeIcon type={column.type} />
          <span className="truncate">{column.name}</span>
        </button>
      )}
      {open && submenu === null && (
        <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded-md border border-border bg-popover shadow-md p-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setRenaming(true);
            }}
            className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
          >
            Rename
          </button>
          {column.type === "number" && onPatch && (
            <>
              <button
                type="button"
                onClick={() => setSubmenu("format")}
                className="flex items-center justify-between w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
              >
                <span>Number format</span>
                <span className="text-xs text-muted-foreground">
                  {NUMBER_FORMATS.find(
                    (f) => f.value === (column.format ?? "number"),
                  )?.label ?? "Number"}{" "}
                  ›
                </span>
              </button>
              <button
                type="button"
                onClick={() => setSubmenu("precision")}
                className="flex items-center justify-between w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
              >
                <span>Decimal places</span>
                <span className="text-xs text-muted-foreground">
                  {column.precision === undefined ? "Default" : column.precision}{" "}
                  ›
                </span>
              </button>
            </>
          )}
          {onSetCalculation && (
            <button
              type="button"
              onClick={() => setSubmenu("calculate")}
              className="flex items-center justify-between w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
            >
              <span>Calculate</span>
              <span className="text-xs text-muted-foreground">
                {CALC_OPTIONS.find((c) => c.value === (currentCalc ?? null))
                  ?.label ?? "None"}{" "}
                ›
              </span>
            </button>
          )}
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Type
          </div>
          {(["text", "number", "select", "multi_select", "checkbox", "date"] as ColumnType[]).map(
            (t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (t !== column.type) onChangeType(t);
                }}
                className="flex items-center gap-2 w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
              >
                <ColumnTypeIcon type={t} />
                <span>{columnTypeLabel(t)}</span>
                {t === column.type && <span className="ml-auto text-xs">✓</span>}
              </button>
            ),
          )}
          <div className="border-t border-border/60 my-1" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onHide();
            }}
            className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
          >
            Hide in this view
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="block w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted text-foreground"
            >
              Delete column
            </button>
          )}
        </div>
      )}
      {open && submenu === "format" && onPatch && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover shadow-md p-1">
          <button
            type="button"
            onClick={() => setSubmenu(null)}
            className="block w-full px-2 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
          >
            ← Back
          </button>
          <div className="border-t border-border/60 my-1" />
          {NUMBER_FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => {
                onPatch({ format: f.value });
                setSubmenu(null);
                setOpen(false);
              }}
              className="flex items-center justify-between w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
            >
              <span>{f.label}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {f.sample}
              </span>
              {f.value === (column.format ?? "number") && (
                <span className="ml-1 text-xs">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
      {open && submenu === "precision" && onPatch && (
        <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-md border border-border bg-popover shadow-md p-1">
          <button
            type="button"
            onClick={() => setSubmenu(null)}
            className="block w-full px-2 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
          >
            ← Back
          </button>
          <div className="border-t border-border/60 my-1" />
          {DECIMAL_OPTIONS.map((d) => (
            <button
              key={String(d.value)}
              type="button"
              onClick={() => {
                onPatch({ precision: d.value ?? undefined });
                setSubmenu(null);
                setOpen(false);
              }}
              className="flex items-center justify-between w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
            >
              <span>{d.label}</span>
              {d.value === (column.precision ?? null) && (
                <span className="text-xs">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
      {open && submenu === "calculate" && onSetCalculation && (
        <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-md border border-border bg-popover shadow-md p-1">
          <button
            type="button"
            onClick={() => setSubmenu(null)}
            className="block w-full px-2 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
          >
            ← Back
          </button>
          <div className="border-t border-border/60 my-1" />
          {CALC_OPTIONS.filter((c) =>
            // Only number columns can sum/avg/min/max — others get None + Count.
            column.type === "number" || c.value === null || c.value === "count",
          ).map((c) => (
            <button
              key={String(c.value)}
              type="button"
              onClick={() => {
                onSetCalculation(c.value);
                setSubmenu(null);
                setOpen(false);
              }}
              className="flex items-center justify-between w-full px-2 py-1.5 text-left text-sm rounded-sm hover:bg-muted"
            >
              <span>{c.label}</span>
              {c.value === (currentCalc ?? null) && (
                <span className="text-xs">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ColumnTypeIcon({ type }: { type: ColumnType }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  switch (type) {
    case "text":
      return <Type className={cls} aria-label="Text" />;
    case "number":
      return <Hash className={cls} aria-label="Number" />;
    case "select":
      return <ListChecks className={cls} aria-label="Select" />;
    case "multi_select":
      return <Tags className={cls} aria-label="Multi-select" />;
    case "checkbox":
      return <CheckSquare className={cls} aria-label="Checkbox" />;
    case "date":
      return <Calendar className={cls} aria-label="Date" />;
  }
}
