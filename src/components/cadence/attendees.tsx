import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAllPeople } from "@/lib/hooks/use-people";
import type { AttendeeDto } from "@/lib/hooks/use-events";

// Attendee primitives shared by the vault-local and iCal event detail
// pages. The server resolves each raw attendee against the People
// folder via the in-memory people-email index — matched rows arrive
// with `personId` set and render as clickable wikilinks; unmatched
// rows render their fallback label (email or raw id) as plain text.
//
// The picker (`AttendeePicker`) is a small popover that lists every
// person in the vault, filtered by a search input. Selecting a person
// emits the chosen id so the caller can append it to the event's
// `attendees` array via the existing `event_update` command.

interface AttendeeChipProps {
  attendee: AttendeeDto;
  /** Optional remove handler. When set, an `×` button appears on
   *  hover. Only wired for vault-local events for now — iCal
   *  attendees come from Google and can't be removed in Woodshed. */
  onRemove?: () => void;
}

export function AttendeeChip({ attendee, onRemove }: AttendeeChipProps) {
  // Matched: tinted pill with always-on underline. The pill bg + the
  // underline at rest are deliberately both present so the row reads
  // as clickable without a hover. Compared to the unmatched email
  // (plain muted text, no chrome), matched rows stand out clearly as
  // "this is a person you can jump to." Hover deepens both signals.
  const inner = attendee.personId ? (
    <Link
      to="/people/$id"
      params={{ id: attendee.personId }}
      title={attendee.email ?? undefined}
      className="text-foreground underline underline-offset-[3px] decoration-muted-foreground/60 hover:decoration-foreground hover:bg-foreground/[0.05] transition-colors rounded-sm -mx-0.5 px-0.5"
    >
      {attendee.name}
    </Link>
  ) : (
    // Unmatched: just the email or raw id, no underline, muted color.
    // Stays in the body-text hierarchy so resolved people stand out by
    // contrast.
    <span className="text-muted-foreground">{attendee.name}</span>
  );

  if (!onRemove) {
    return <span className="inline-flex items-center">{inner}</span>;
  }

  return (
    <span className="group/attendee inline-flex items-center gap-0.5">
      {inner}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attendee.name}`}
        className="opacity-0 group-hover/attendee:opacity-100 focus:opacity-100 transition-opacity h-4 w-4 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

interface AttendeePickerProps {
  /** Person ids already on the event. Filtered out of the picker so
   *  the user can't add the same person twice. */
  exclude: string[];
  /** Fires with the chosen person's id. Caller decides how to
   *  persist (vault-local events: append to attendees + event_update). */
  onPick: (personId: string) => void;
}

/**
 * Inline "+ Add person" trigger that opens a search-as-you-type
 * popover listing every person in the vault. Selecting a person
 * commits via `onPick` and closes.
 */
export function AttendeePicker({ exclude, onPick }: AttendeePickerProps) {
  // `?? []` (rather than destructure default) so `null` and `undefined`
  // both fall back to an empty list — see people-list.tsx for why.
  const { data } = useAllPeople();
  const people = data ?? [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const excludeSet = useMemo(() => new Set(exclude), [exclude]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const candidates = people.filter((p) => !excludeSet.has(p.id));
    if (!q) return candidates.slice(0, 8);
    return candidates
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.email.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [people, query, excludeSet]);

  useEffect(() => {
    if (open) {
      // Tiny delay lets the popover mount before we focus, otherwise
      // base-ui's open animation eats the focus.
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
    setQuery("");
  }, [open]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label="Add attendee"
        className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground transition-colors -mx-1 px-1 py-0.5 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
      >
        <Plus className="h-3 w-3" />
        <span>Add</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="w-64 p-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
          placeholder="Search people…"
          className="w-full px-2 h-7 text-[13px] rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)] mb-1"
        />
        {filtered.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground italic">
            {people.length === 0
              ? "No people in the vault yet."
              : "No matches."}
          </p>
        ) : (
          <ul className="space-y-px max-h-64 overflow-y-auto">
            {filtered.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(p.id);
                    setOpen(false);
                  }}
                  className="w-full text-left px-2 py-1 rounded-sm text-[13px] hover:bg-foreground/[0.05] focus:outline-none focus:bg-foreground/[0.05] flex items-center justify-between gap-2"
                >
                  <span className="truncate">{p.name}</span>
                  {p.email && (
                    <span className="text-muted-foreground text-[11px] truncate">
                      {p.email}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
