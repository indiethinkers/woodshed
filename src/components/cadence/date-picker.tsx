import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Popover } from "@base-ui/react/popover";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useToday } from "@/lib/hooks/use-today";
import { monthStart, addMonths } from "./date-utils";

export function DatePicker({ showDayNav = true }: { showDayNav?: boolean } = {}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const today = useToday();
  const selected = extractDate(pathname, today);

  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => monthStart(selected));

  // Re-anchor the visible month whenever the selected date moves while the
  // popover is closed (e.g. user navigated to another day from elsewhere).
  // Mutating mid-open would jerk the grid out from under their click.
  useEffect(() => {
    if (!open) setViewMonth(monthStart(selected));
  }, [selected, open]);

  const label = formatDisplay(selected);

  function navigateTo(date: string) {
    setOpen(false);
    // dayHrefFor returns either "/" or "/cadence/<date>" — a runtime
    // string, not a route-registry literal. Use `href` so the router
    // parses the pathname instead of trying to match a typed `to`.
    void navigate({ href: dayHrefFor(date, today), viewTransition: true });
  }

  const prevDate = addDays(selected, -1);
  const nextDate = addDays(selected, 1);

  return (
    <span className="inline-flex items-center gap-0.5 shrink-0">
      {showDayNav && (
        <Link
          {...dayLinkProps(prevDate, today)}
          viewTransition
          aria-label="Previous day"
          className="h-6 w-6 inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Link>
      )}
      <Link
        {...dayLinkProps(selected, today)}
        viewTransition
        // When there are no day-nav arrows the date is the leading element, so
        // -ml-2 cancels its px-2 hover padding and lands the text on the column
        // edge — aligning the breadcrumb with the page title and content below.
        className={`px-2 py-1 -my-0.5 ${showDayNav ? "" : "-ml-2"} rounded-md text-sm font-medium text-foreground hover:bg-foreground/[0.05] transition-colors whitespace-nowrap`}
      >
        {label}
      </Link>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label="Open date picker"
          className="h-6 w-6 inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <CalendarDays className="h-3.5 w-3.5" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner className="z-50" sideOffset={6} align="start">
            <Popover.Popup className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-3 w-[280px]">
              <CalendarGrid
                viewMonth={viewMonth}
                selected={selected}
                today={today}
                onPrev={() => setViewMonth(addMonths(viewMonth, -1))}
                onNext={() => setViewMonth(addMonths(viewMonth, 1))}
                onPick={navigateTo}
                onJumpToday={() => navigateTo(today)}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {showDayNav && (
        <Link
          {...dayLinkProps(nextDate, today)}
          viewTransition
          aria-label="Next day"
          className="h-6 w-6 inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </span>
  );
}

/// Step a YYYY-MM-DD by `n` days (positive or negative). Calendar-day
/// math via the local-noon trick: anchoring at 00:00 local then
/// add/sub by 1d crosses DST safely on the rare boundary day.
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toISO(d);
}

function dayHrefFor(date: string, today: string): string {
  return date === today ? "/" : `/cadence/${date}`;
}

// Typed Link props for a calendar day. TanStack Router's <Link>
// requires a route-registry `to` (the `href` prop alone won't drive
// navigation), so we discriminate between Today (which lives at "/")
// and any other day (which routes to /cadence/$date). Spread into a
// <Link> at the call site.
type DayLinkProps =
  | { to: "/" }
  | { to: "/cadence/$date"; params: { date: string } };

function dayLinkProps(date: string, today: string): DayLinkProps {
  return date === today
    ? { to: "/" }
    : { to: "/cadence/$date", params: { date } };
}

export function CalendarGrid({
  viewMonth,
  selected,
  today,
  onPrev,
  onNext,
  onPick,
  onJumpToday,
}: {
  viewMonth: Date;
  selected: string;
  today: string;
  onPrev: () => void;
  onNext: () => void;
  onPick: (date: string) => void;
  onJumpToday: () => void;
}) {
  const days = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);

  return (
    <div>
      {/* Month header */}
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={onPrev}
          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-foreground/[0.06] text-muted-foreground"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <div className="text-sm font-medium">
          {viewMonth.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          })}
        </div>
        <button
          type="button"
          onClick={onNext}
          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-foreground/[0.06] text-muted-foreground"
          aria-label="Next month"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 mb-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div
            key={i}
            className="text-[10px] font-medium text-muted-foreground text-center py-1"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Days */}
      <div className="grid grid-cols-7 gap-px">
        {days.map((day) => {
          const iso = toISO(day);
          const isOtherMonth = day.getMonth() !== viewMonth.getMonth();
          const isSelected = iso === selected;
          const isToday = iso === today;

          return (
            <button
              key={iso}
              type="button"
              onClick={() => onPick(iso)}
              className={`h-7 w-full inline-flex items-center justify-center text-[12.5px] rounded transition-colors ${
                isSelected
                  ? "bg-foreground text-background font-semibold"
                  : isToday
                    ? "bg-foreground/[0.08] text-foreground font-semibold hover:bg-foreground/[0.12]"
                    : isOtherMonth
                      ? "text-muted-foreground/50 hover:bg-foreground/[0.04]"
                      : "text-foreground hover:bg-foreground/[0.06]"
              }`}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="mt-2 pt-2 border-t border-border flex justify-end">
        <button
          type="button"
          onClick={onJumpToday}
          className="text-[12px] text-muted-foreground hover:text-foreground transition-colors px-2 py-0.5 rounded"
        >
          Jump to today
        </button>
      </div>
    </div>
  );
}

function extractDate(pathname: string, today: string): string {
  const match = pathname.match(/^\/cadence\/([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  return match ? match[1] : today;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildMonthGrid(viewMonth: Date): Date[] {
  // Start on Sunday before (or equal to) the 1st of the viewMonth.
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  // 6 weeks × 7 days = 42 cells.
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function formatDisplay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
