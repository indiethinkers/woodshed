import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Notion-style key/value list, Woodshed-quiet.
//
// Property labels live in JetBrains Mono — the same typeface used for
// schedule times and other metadata across the app — so the page reads in
// one consistent voice instead of stitching a "labels" type on top of the
// content type. Values use the body typeface (Söhne fallback) and only get
// chrome (background, focus ring) during interaction.
//
// The grid is `[120px 1fr]` with a 24px gap. The label column is wide enough
// for two-word labels ("Company", "Tags", "Mentioned in") but narrow enough
// that the values get the bulk of the page width. Rows are baseline-aligned
// so the mono labels and proportional values share a single visual line.

/**
 * Property rows whose `empty` prop is true are collapsed behind a quiet
 * "N empty properties" toggle at the bottom of the list, so a record with
 * mostly-unset metadata reads clean instead of as a wall of "Empty"
 * placeholders. Filled rows always render, in source order; revealing the
 * empty group lets the user fill any of them. Rows that don't pass `empty`
 * (most consumers) are treated as filled — behavior is unchanged for them.
 */
export function PropertyList({ children }: { children: ReactNode }) {
  const [showEmpty, setShowEmpty] = useState(false);
  const rows = Children.toArray(children).filter(isValidElement);
  const emptyRows = rows.filter(
    (row) => (row.props as PropertyRowProps).empty === true,
  );
  const filledRows = rows.filter(
    (row) => (row.props as PropertyRowProps).empty !== true,
  );

  return (
    <div className="space-y-px">
      {filledRows}
      {showEmpty && emptyRows}
      {emptyRows.length > 0 && (
        <button
          type="button"
          onClick={() => setShowEmpty((v) => !v)}
          className="group mt-1 flex items-center gap-1.5 -mx-2 px-2 py-1 rounded-sm font-mono text-[12px] text-muted-foreground/70 hover:text-muted-foreground hover:bg-foreground/[0.03] transition-colors select-none"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 transition-transform",
              showEmpty && "rotate-90",
            )}
          />
          {showEmpty
            ? "Hide empty"
            : `${emptyRows.length} empty ${
                emptyRows.length === 1 ? "property" : "properties"
              }`}
        </button>
      )}
    </div>
  );
}

interface PropertyRowProps {
  /** Mono-typed label in the left column. Plain text, no icon. */
  label: string;
  /** The value cell. Render `<EmptyValue>` for an empty placeholder. */
  children: ReactNode;
  /**
   * Optional right-edge affordance that fades in on row hover — typically a
   * tiny copy / open / caret glyph for the value. Don't put primary
   * interactivity here; the value cell itself should be clickable when an
   * edit is intended.
   */
  trailing?: ReactNode;
  /**
   * When true, the row is collapsed by the parent `PropertyList` behind its
   * "N empty properties" toggle. The row itself renders identically; the flag
   * is read off `props` by the list. Consumers compute it from their own
   * notion of an unset value (e.g. `empty={!person.role}`).
   */
  empty?: boolean;
}

export function PropertyRow({ label, children, trailing }: PropertyRowProps) {
  return (
    <div className="group grid grid-cols-[120px_1fr] gap-6 items-baseline min-h-8 px-2 -mx-2 rounded-sm hover:bg-foreground/[0.03] transition-colors">
      <span
        className="font-mono text-[13px] text-muted-foreground select-none pt-1"
        // `pt-1` nudges the mono label down so its ascender aligns with the
        // proportional value's cap-height. Eyeballed against the schedule
        // block which uses the same trick.
      >
        {label}
      </span>
      <div className="text-[15px] text-foreground flex items-center justify-between gap-2 min-w-0 py-1">
        <div className="min-w-0 flex-1">{children}</div>
        {trailing && (
          <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
            {trailing}
          </div>
        )}
      </div>
    </div>
  );
}

/** Italic muted placeholder for an empty value cell. */
export function EmptyValue({ children = "Empty" }: { children?: ReactNode }) {
  return <span className="italic text-muted-foreground/60">{children}</span>;
}

// ---------- Editable variants ----------

interface TextPropertyValueProps {
  value: string;
  placeholder?: string;
  /** Called with the trimmed new value on commit (blur / Enter). */
  onCommit: (next: string) => void;
  /** Optional input type — defaults to "text". Use "email" for hint UI. */
  inputType?: "text" | "email" | "url";
}

/**
 * Click-to-edit text value. Reads as plain text in the row's hover state;
 * becomes an input on click with no border/background change beyond the
 * focus ring. Enter or blur commits, Escape cancels and reverts.
 */
export function TextPropertyValue({
  value,
  placeholder = "Empty",
  onCommit,
  inputType = "text",
}: TextPropertyValueProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-sync external edits while not actively editing — same pattern the
  // current detail page uses for inline fields.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next === value) return;
    onCommit(next);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={inputType}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder={placeholder}
        className="w-full bg-transparent outline-none focus:outline-none placeholder:text-muted-foreground/50 text-[15px] text-foreground -mx-1 px-1 rounded-sm focus:ring-2 focus:ring-foreground/15"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="w-full text-left -mx-1 px-1 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 truncate"
    >
      {value ? value : <EmptyValue>{placeholder}</EmptyValue>}
    </button>
  );
}

// ---------- Pickers (Area / Color) ----------

interface PickerOption<T extends string> {
  value: T;
  label: string;
  /** Optional dot color (CSS color string). Renders as a 8px circle before
   *  the label both in the trigger and in the dropdown items. */
  dot?: string;
}

interface BasePickerProps<T extends string> {
  options: PickerOption<T>[];
  /** Shown when `value` doesn't match any option (or is null when clearable). */
  emptyLabel?: string;
}

/**
 * Discriminated by `clearable`: non-clearable pickers commit a `T`, clearable
 * ones commit `T | null`. Two shapes so call sites that don't need the clear
 * affordance keep the tight `T`-only typing they had before.
 */
type PickerPropertyValueProps<T extends string> =
  | (BasePickerProps<T> & {
      clearable?: false;
      value: T;
      onCommit: (next: T) => void;
    })
  | (BasePickerProps<T> & {
      clearable: true;
      value: T | null;
      onCommit: (next: T | null) => void;
      /** Label for the clear item at the bottom of the dropdown. */
      clearLabel?: string;
    });

/**
 * Single-select picker — used for the Area row. Renders as a button that
 * shows the current option (with its dot, when defined). Click opens a
 * dropdown menu; selecting commits and closes. Pass `clearable` to append
 * a divider + "No area"-style item that commits `null`.
 */
export function PickerPropertyValue<T extends string>(
  props: PickerPropertyValueProps<T>,
) {
  const { value, options, onCommit, emptyLabel = "Empty" } = props;
  const clearable = props.clearable === true;
  const clearLabel = clearable ? props.clearLabel ?? emptyLabel : emptyLabel;
  const current = value == null ? undefined : options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="w-full text-left -mx-1 px-1 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 flex items-center gap-2 truncate">
        {current?.dot && (
          <span
            aria-hidden
            className="h-2 w-2 rounded-full shrink-0"
            style={{ backgroundColor: current.dot }}
          />
        )}
        {current ? (
          <span className="truncate">{current.label}</span>
        ) : (
          <EmptyValue>{emptyLabel}</EmptyValue>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-44">
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onClick={() => onCommit(opt.value)}
            className="flex items-center gap-2 text-[14px]"
          >
            {opt.dot && (
              <span
                aria-hidden
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: opt.dot }}
              />
            )}
            <span className="flex-1 truncate">{opt.label}</span>
            {opt.value === value && (
              <Check className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </DropdownMenuItem>
        ))}
        {clearable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => (onCommit as (next: T | null) => void)(null)}
              className="flex items-center gap-2 text-[14px] text-muted-foreground"
            >
              <span className="flex-1 truncate">{clearLabel}</span>
              {value == null && (
                <Check className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
