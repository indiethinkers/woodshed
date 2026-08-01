import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import type {
  CellValue,
  ColumnDto,
  NumberFormat,
  SelectOption,
} from "@/lib/hooks/use-tables";
import { selectOptionColor } from "./option-colors";
import { formatNumber } from "./format-number";

interface CellProps {
  column: ColumnDto;
  value: CellValue | undefined;
  onCommit: (next: CellValue) => void;
  /** Optional: handles option creation for select columns. */
  onCreateOption?: (option: SelectOption) => void;
  /** When true on mount, text cells start in edit mode. Used for the
   *  "+ New item" flow so the cursor lands in the title column without
   *  the user having to click. */
  autoFocus?: boolean;
}

function isPlainTypingKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): boolean {
  return (
    event.key.length === 1 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.isComposing
  );
}

function startCellEditingFromKey(
  event: React.KeyboardEvent<HTMLElement>,
  startEditing: (key: string) => void,
  acceptsKey: (key: string) => boolean = () => true,
): void {
  if (!isPlainTypingKey(event) || !acceptsKey(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  startEditing(event.key);
}

/**
 * Type-aware cell renderer. Each column type has its own editor; the cell
 * is always read-only at rest and switches to an inline editor on click.
 * Commits via blur / Enter / Escape (for selects, click-outside).
 */
export function Cell({
  column,
  value,
  onCommit,
  onCreateOption,
  autoFocus = false,
}: CellProps) {
  switch (column.type) {
    case "text":
      return (
        <TextCell value={asString(value)} onCommit={onCommit} autoFocus={autoFocus} />
      );
    case "number":
      return (
        <NumberCell
          value={asNumber(value)}
          onCommit={onCommit}
          format={column.format ?? "number"}
          precision={column.precision}
        />
      );
    case "select":
      return (
        <SelectCell
          value={asString(value)}
          options={column.options ?? []}
          onCommit={onCommit}
          onCreateOption={onCreateOption}
        />
      );
    case "multi_select":
      return (
        <MultiSelectCell
          value={asStringArray(value)}
          options={column.options ?? []}
          onCommit={onCommit}
          onCreateOption={onCreateOption}
        />
      );
    case "checkbox":
      return <CheckboxCell value={asBool(value)} onCommit={onCommit} />;
    case "date":
      return <DateCell value={asString(value)} onCommit={onCommit} />;
  }
}

function asString(v: CellValue | undefined): string {
  if (v === null || v === undefined) return "";
  return String(v);
}
function asNumber(v: CellValue | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function asBool(v: CellValue | undefined): boolean {
  return v === true;
}
function asStringArray(v: CellValue | undefined): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

function TextCell({
  value,
  onCommit,
  autoFocus = false,
}: {
  value: string;
  onCommit: (v: CellValue) => void;
  autoFocus?: boolean;
}) {
  // Start in edit mode when autoFocus is true (newly-created row flow).
  const [editing, setEditing] = useState(autoFocus);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft === value) return;
    onCommit(draft === "" ? null : draft);
  }
  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        className="w-full bg-transparent outline-none text-sm"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      onKeyDown={(event) =>
        startCellEditingFromKey(event, (key) => {
          setDraft(key);
          setEditing(true);
        })
      }
      className="block w-full text-left text-sm truncate text-foreground"
    >
      {value || <span className="text-muted-foreground/40">&nbsp;</span>}
    </button>
  );
}

function NumberCell({
  value,
  onCommit,
  format,
  precision,
}: {
  value: number | null;
  onCommit: (v: CellValue) => void;
  format: NumberFormat;
  precision: number | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value === null ? "" : String(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      setDraft(value === null ? "" : String(value));
      return;
    }
    if (n === value) return;
    onCommit(n);
  }

  if (editing) {
    // Edit mode shows the raw number — formatting is for display only, not
    // input. The user types the underlying value; format is reapplied on blur.
    // Spinner buttons on `<input type="number">` are hidden via the
    // appearance-none rules below — they look out of place in a Notion-style
    // grid and steal horizontal area.
    return (
      <input
        ref={ref}
        type="number"
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value === null ? "" : String(value));
            setEditing(false);
          }
        }}
        className="w-full bg-transparent outline-none text-sm tabular-nums text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      onKeyDown={(event) =>
        startCellEditingFromKey(
          event,
          (key) => {
            setDraft(key);
            setEditing(true);
          },
          (key) => /^[0-9.+-]$/.test(key),
        )
      }
      className="block w-full text-right text-sm tabular-nums text-foreground"
    >
      {value === null ? (
        <span className="text-muted-foreground/40">&nbsp;</span>
      ) : (
        formatNumber(value, format, precision)
      )}
    </button>
  );
}

function CheckboxCell({
  value,
  onCommit,
}: {
  value: boolean;
  onCommit: (v: CellValue) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCommit(!value)}
      aria-pressed={value}
      className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
        value
          ? "bg-foreground border-foreground"
          : "bg-transparent border-border hover:border-foreground/50"
      }`}
    >
      {value && <Check className="h-3 w-3 text-background" strokeWidth={3} />}
    </button>
  );
}

function DateCell({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: CellValue) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft === value) return;
    onCommit(draft === "" ? null : draft);
  }

  if (editing) {
    return (
      <input
        ref={ref}
        type="date"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        className="w-full bg-transparent outline-none text-sm"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      onKeyDown={(event) =>
        startCellEditingFromKey(event, () => setEditing(true), (key) =>
          /^\d$/.test(key),
        )
      }
      className="block w-full text-left text-sm tabular-nums text-foreground"
    >
      {value || <span className="text-muted-foreground/40">&nbsp;</span>}
    </button>
  );
}

function SelectCell({
  value,
  options,
  onCommit,
  onCreateOption,
}: {
  value: string;
  options: SelectOption[];
  onCommit: (v: CellValue) => void;
  onCreateOption?: (option: SelectOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const selected = options.find((o) => o.id === value) ?? null;
  const filtered = search.trim()
    ? options.filter((o) =>
        o.name.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : options;
  const exactMatch = options.find(
    (o) => o.name.toLowerCase() === search.trim().toLowerCase(),
  );

  function pick(id: string) {
    setOpen(false);
    setSearch("");
    if (id === value) return;
    onCommit(id);
  }

  function clear() {
    setOpen(false);
    setSearch("");
    if (value) onCommit(null);
  }

  function createAndPick() {
    if (!onCreateOption || !search.trim()) return;
    const newOption: SelectOption = {
      id: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: search.trim(),
      color: nextColor(options.length),
    };
    onCreateOption(newOption);
    setOpen(false);
    setSearch("");
    onCommit(newOption.id);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        onKeyDown={(event) =>
          startCellEditingFromKey(event, (key) => {
            setSearch(key);
            setOpen(true);
          })
        }
        className="block w-full text-left"
      >
        {selected ? (
          <span
            className="inline-block px-2 py-0.5 rounded text-[12px] font-normal leading-tight"
            style={{
              backgroundColor: `hsl(${selectOptionColor(selected.color).bg})`,
              color: `hsl(${selectOptionColor(selected.color).fg})`,
            }}
          >
            {selected.name}
          </span>
        ) : (
          <span className="text-muted-foreground/40 text-sm">&nbsp;</span>
        )}
      </button>
    );
  }

  return (
    <div ref={ref} className="relative">
      <span className="block">
        {selected && (
          <span
            className="inline-block px-2 py-0.5 rounded text-[12px] font-normal leading-tight"
            style={{
              backgroundColor: `hsl(${selectOptionColor(selected.color).bg})`,
              color: `hsl(${selectOptionColor(selected.color).fg})`,
            }}
          >
            {selected.name}
          </span>
        )}
      </span>
      <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover shadow-md p-1">
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              setSearch("");
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (filtered.length === 1) pick(filtered[0].id);
              else if (!exactMatch && search.trim()) createAndPick();
            }
          }}
          placeholder="Search or create…"
          className="w-full px-2 h-7 text-[13px] rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
        />
        <div className="mt-1 max-h-48 overflow-y-auto">
          {filtered.length === 0 && !search.trim() && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground italic">
              No options yet
            </p>
          )}
          {filtered.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => pick(option.id)}
              className="flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm hover:bg-muted transition-colors"
            >
              <span
                className="inline-block px-2 py-0.5 rounded text-[12px] font-normal leading-tight"
                style={{
                  backgroundColor: `hsl(${selectOptionColor(option.color).bg})`,
                  color: `hsl(${selectOptionColor(option.color).fg})`,
                }}
              >
                {option.name}
              </span>
              {option.id === value && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
          {!exactMatch && search.trim() && onCreateOption && (
            <button
              type="button"
              onClick={createAndPick}
              className="flex items-center w-full px-2 py-1.5 text-sm rounded-sm hover:bg-muted transition-colors text-muted-foreground"
            >
              <span className="text-xs">+ Create</span>
              <span className="ml-2 inline-block px-2 py-0.5 rounded text-[12px] font-normal leading-tight bg-muted">
                {search.trim()}
              </span>
            </button>
          )}
        </div>
        {selected && (
          <button
            type="button"
            onClick={clear}
            className="flex items-center gap-1.5 w-full px-2 py-1.5 mt-1 text-xs rounded-sm border-t border-border hover:bg-muted transition-colors text-muted-foreground"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function MultiSelectCell({
  value,
  options,
  onCommit,
  onCreateOption,
}: {
  value: string[];
  options: SelectOption[];
  onCommit: (v: CellValue) => void;
  onCreateOption?: (option: SelectOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const selected = value
    .map((id) => options.find((o) => o.id === id))
    .filter((o): o is SelectOption => !!o);
  const filtered = search.trim()
    ? options.filter((o) =>
        o.name.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : options;
  const exactMatch = options.find(
    (o) => o.name.toLowerCase() === search.trim().toLowerCase(),
  );

  function toggle(id: string) {
    const next = value.includes(id) ? value.filter((v) => v !== id) : [...value, id];
    onCommit(next.length === 0 ? null : next);
  }

  function removePill(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const next = value.filter((v) => v !== id);
    onCommit(next.length === 0 ? null : next);
  }

  function createAndAdd() {
    if (!onCreateOption || !search.trim()) return;
    const newOption: SelectOption = {
      id: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: search.trim(),
      color: nextColor(options.length),
    };
    onCreateOption(newOption);
    setSearch("");
    onCommit([...value, newOption.id]);
  }

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) =>
          startCellEditingFromKey(event, (key) => {
            setSearch(key);
            setOpen(true);
          })
        }
        className="flex flex-wrap gap-1 w-full text-left min-h-[18px]"
      >
        {selected.length > 0 ? (
          selected.map((opt) => (
            <span
              key={opt.id}
              className="group/pill inline-flex items-center gap-1 px-2 py-0.5 rounded text-[12px] font-normal leading-tight"
              style={{
                backgroundColor: `hsl(${selectOptionColor(opt.color).bg})`,
                color: `hsl(${selectOptionColor(opt.color).fg})`,
              }}
            >
              {opt.name}
              <X
                className="h-2.5 w-2.5 opacity-0 group-hover/pill:opacity-70 hover:opacity-100 transition-opacity"
                onClick={(e) => removePill(opt.id, e)}
              />
            </span>
          ))
        ) : (
          <span className="text-muted-foreground/40 text-sm">&nbsp;</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover shadow-md p-1">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                setSearch("");
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (filtered.length === 1) toggle(filtered[0].id);
                else if (!exactMatch && search.trim()) createAndAdd();
              }
            }}
            placeholder="Search or create…"
            className="w-full px-2 h-7 text-[13px] rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
          />
          <div className="mt-1 max-h-48 overflow-y-auto">
            {filtered.length === 0 && !search.trim() && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground italic">
                No options yet
              </p>
            )}
            {filtered.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => toggle(option.id)}
                className="flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm hover:bg-muted transition-colors"
              >
                <span
                  className="inline-block px-2 py-0.5 rounded text-[12px] font-normal leading-tight"
                  style={{
                    backgroundColor: `hsl(${selectOptionColor(option.color).bg})`,
                    color: `hsl(${selectOptionColor(option.color).fg})`,
                  }}
                >
                  {option.name}
                </span>
                {value.includes(option.id) && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
            {!exactMatch && search.trim() && onCreateOption && (
              <button
                type="button"
                onClick={createAndAdd}
                className="flex items-center w-full px-2 py-1.5 text-sm rounded-sm hover:bg-muted transition-colors text-muted-foreground"
              >
                <span className="text-xs">+ Create</span>
                <span className="ml-2 inline-block px-2 py-0.5 rounded text-[12px] font-normal leading-tight bg-muted">
                  {search.trim()}
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function nextColor(seed: number): string {
  const palette = [
    "blue",
    "purple",
    "amber",
    "teal",
    "coral",
    "pink",
    "gray",
  ];
  return palette[seed % palette.length];
}
