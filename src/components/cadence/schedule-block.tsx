import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { DaybookSectionHeader } from "./daybook-section-header";
import { extractDate } from "./task-sidebar";
import { RichText } from "@/components/shared/rich-text";
import { useEvents, type EventDto } from "@/lib/hooks/use-events";
import { useGcalAccounts, useGcalSync } from "@/lib/hooks/use-gcal";
import { useToday } from "@/lib/hooks/use-today";
import { cn } from "@/lib/utils";
import { NewEventForm } from "./new-event-form";
import { useFixedNowMs } from "@/lib/demo-clock";

const SCHEDULE_COLLAPSED_STORAGE_KEY = "woodshed:cadence:schedule-collapsed";
const EMPTY_EVENTS: EventDto[] = [];

/** `page` = the wide content-panel block (non-Tauri/web). `sidebar` = the
 *  compact form that lives below the tasks in the inner list panel — tighter
 *  padding, and "+ Event" opens in a popover instead of a wide inline form. */
type ScheduleVariant = "page" | "sidebar";

/**
 * Inner-sidebar schedule. Reads the showing day off the pathname — the same
 * derivation the task list uses — so the schedule below the tasks always
 * tracks the day the user is viewing (today at `/`, a specific day at
 * `/cadence/<date>`, today on an event/task detail page).
 */
export function SidebarSchedule() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const today = useToday();
  const date = extractDate(pathname) ?? today;
  return <ScheduleBlock date={date} variant="sidebar" />;
}

interface ScheduleBlockProps {
  /** YYYY-MM-DD; events on this date render in the timeline rail. */
  date: string;
  variant?: ScheduleVariant;
}

export function ScheduleBlock({ date, variant = "page" }: ScheduleBlockProps) {
  const { data: eventsData, isLoading } = useEvents(date);
  const events = eventsData ?? EMPTY_EVENTS;
  const { data: gcalAccounts = [] } = useGcalAccounts();
  const sync = useGcalSync();
  const [adding, setAdding] = useState(false);
  // Explicit collapse override, persisted across day navigation and remounts.
  // null = follow the default (collapsed only when the day is wrapped);
  // true/false = the user's choice, which sticks for every day until they
  // toggle it the other way. Seeded from localStorage so a collapse made in a
  // prior session is still in effect on load. (ScheduleBlock re-renders with a
  // new `date` rather than remounting across day navigation, so this state is
  // intentionally not reset on date change.)
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(() =>
    readScheduleCollapsed(),
  );
  // Whether the user toggled collapse during this mount. Gates the expand-in
  // animation so a preference restored from storage doesn't fade the list on
  // first load (see `animateList`).
  const [interacted, setInteracted] = useState(false);
  const hasGcal = gcalAccounts.length > 0;
  const fixedNowMs = useFixedNowMs();

  // In the inner list panel the schedule is pinned to the bottom (shrink-0,
  // so the scrolling task list above never compresses it) and carries its own
  // divider + gutters; the page variant inherits the content column's spacing
  // and adds none of its own.
  const sectionClass =
    variant === "sidebar"
      ? "shrink-0 border-t border-border px-4 pt-5 pb-6"
      : undefined;
  // Reserve room for ~7 event rows (26px each) so the pinned schedule keeps a
  // stable footprint on light days; busy days grow it and shrink the task
  // scroll area above.
  const listClass = variant === "sidebar" ? "mt-3 min-h-[182px]" : "mt-3";

  function setCollapsedPreference(collapsed: boolean) {
    setUserCollapsed(collapsed);
    setInteracted(true);
    writeScheduleCollapsed(collapsed);
  }
  const hasCalendarSource =
    hasGcal || events.some((event) => event.provider === "ical");

  const accountColors = new Map(
    gcalAccounts.map((account) => [account.id, account.color]),
  );

  // "Wrapped" = the day has events and every one has already ended. Holds for
  // a past day (all done) and for today once the last meeting finishes; a
  // future day's events are still ahead. The clock below wakes only when the
  // next event ends, so completed styling flips without a per-second ticker.
  // Drives the *default* collapsed state; the user can override either way via
  // `userCollapsed`.
  const now = useEventCompletionClock(events, fixedNowMs);

  if (isLoading) {
    return (
      <section className={sectionClass}>
        <DaybookSectionHeader label="Schedule" />
        {/* Reserve the same footprint as the resolved list (`listClass`) so the
            section doesn't jump as it loads in, and stay quiet — the events
            read is fast and local, so an animated skeleton just flashes before
            the list appears. (See plan 008.) */}
        <div className={cn(listClass, "mt-3")} aria-hidden />
      </section>
    );
  }

  const dayWrapped =
    events.length > 0 && events.every((event) => eventEndMs(event) <= now);

  // Collapse when wrapped by default, but honor an explicit user choice. The
  // list animates in on expand — except on first render (no in-session toggle),
  // so neither a normal day nor a restored expand preference fades on load.
  const collapsed = userCollapsed ?? dayWrapped;
  const animateList = interacted;

  return (
    <section className={sectionClass}>
      <DaybookSectionHeader
        label="Schedule"
        right={
          <div className="flex items-center justify-end gap-3">
            {hasCalendarSource && (
              <button
                type="button"
                onClick={() => sync.mutate()}
                disabled={sync.isPending}
                title="Pull the latest events from your Google Calendars"
                aria-label="Sync calendars"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${sync.isPending ? "animate-spin" : ""}`}
                  strokeWidth={1.8}
                />
              </button>
            )}
            {variant === "sidebar" ? (
              // The narrow column can't host the wide inline form, so the
              // creator floats in a popover anchored to the trigger.
              <Popover.Root open={adding} onOpenChange={setAdding}>
                <Popover.Trigger className="whitespace-nowrap text-[14px] text-muted-foreground transition-colors hover:text-foreground">
                  + Event
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner
                    className="z-50"
                    sideOffset={8}
                    align="end"
                  >
                    <Popover.Popup className="w-[320px] rounded-md bg-popover text-popover-foreground shadow-lg outline-none">
                      <NewEventForm
                        date={date}
                        onCreated={() => setAdding(false)}
                        onCancel={() => setAdding(false)}
                      />
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            ) : (
              <button
                type="button"
                onClick={() => setAdding((current) => !current)}
                className="whitespace-nowrap text-[14px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {adding ? "Cancel" : "+ Event"}
              </button>
            )}
          </div>
        }
      />

      {variant === "page" && adding && (
        <div className="mt-8 max-w-[840px]">
          <NewEventForm
            date={date}
            onCreated={() => setAdding(false)}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      <div className={listClass}>
        {events.length === 0 ? (
          <NoEventsRow />
        ) : collapsed ? (
          <WrappedSummary
            events={events}
            onExpand={() => setCollapsedPreference(false)}
          />
        ) : (
          <>
            <ul
              className={
                animateList
                  ? "animate-in fade-in-0 slide-in-from-top-1 duration-300"
                  : undefined
              }
            >
              {events.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  nowMs={now}
                  markerColor={
                    event.accountId
                      ? accountColors.get(event.accountId)
                      : undefined
                  }
                />
              ))}
            </ul>
            {/* The sidebar omits the manual collapse link — it's a persistent
                reference panel; only the page variant offers re-collapsing. */}
            {variant === "page" && (
              <CollapseToggle onCollapse={() => setCollapsedPreference(true)} />
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Empty-day rail row — a single muted line in the timeline grid. */
function NoEventsRow() {
  return (
    <div className="grid min-h-[26px] grid-cols-[auto_3px_minmax(0,1fr)] items-center gap-3 text-muted-foreground">
      <div className="font-mono text-[12px] tabular-nums">--:--</div>
      <span
        aria-hidden
        className="h-3 w-[3px] rounded-full bg-muted-foreground/30"
      />
      <p className="min-w-0 text-[13.5px] italic">No events scheduled today.</p>
    </div>
  );
}

/**
 * Collapsed schedule — the default for a day whose events are all behind you,
 * and available on demand for any day (the user can collapse to reclaim
 * vertical space). One quiet line that mirrors the section-header rhythm —
 * lead · rule · meta — where the "rule" is a day-sparkline: the day's span as a
 * hairline with a dot per event, so the shape of the day reads at a glance.
 * Click anywhere to expand.
 */
function WrappedSummary({
  events,
  onExpand,
}: {
  events: EventDto[];
  onExpand: () => void;
}) {
  const count = events.length;
  const startMs = Math.min(...events.map((event) => Date.parse(event.date)));
  const endMs = Math.max(...events.map(eventEndMs));
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      aria-label={`Show schedule — ${count} ${count === 1 ? "event" : "events"} today`}
      className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 -mx-2 px-2 py-1 rounded-md text-left transition-colors hover:bg-foreground/[0.02]"
    >
      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
        {count} {count === 1 ? "event" : "events"}
      </span>

      {count >= 2 ? (
        <DaySparkline events={events} startMs={startMs} endMs={endMs} />
      ) : (
        <span aria-hidden />
      )}

      <span className="flex items-center gap-2 font-mono text-[12px] tabular-nums text-muted-foreground">
        <span>
          {formatClock(startMs)}
          <span className="mx-0.5 text-muted-foreground/45">–</span>
          {formatClock(endMs)}
        </span>
        <ChevronDown
          className="h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 group-hover:translate-y-0.5 group-hover:text-foreground"
          strokeWidth={1.8}
        />
      </span>
    </button>
  );
}

/**
 * The day as a hairline, with a dot at each event's start across the
 * first-start → last-end span. Monochrome and whisper-quiet — it carries the
 * "shape of the day" without competing with the journal below.
 */
function DaySparkline({
  events,
  startMs,
  endMs,
}: {
  events: EventDto[];
  startMs: number;
  endMs: number;
}) {
  const span = Math.max(1, endMs - startMs);
  return (
    <span aria-hidden className="relative mx-1 block h-3">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
      {events.map((event, i) => {
        const frac = Math.min(
          1,
          Math.max(0, (Date.parse(event.date) - startMs) / span),
        );
        return (
          <span
            key={`${event.id}-${i}`}
            className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/40"
            style={{ left: `${frac * 100}%` }}
          />
        );
      })}
    </span>
  );
}

/** Collapse control shown beneath the expanded list on any day with events. */
function CollapseToggle({ onCollapse }: { onCollapse: () => void }) {
  return (
    <button
      type="button"
      onClick={onCollapse}
      aria-expanded
      className="group mt-2 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      <ChevronUp
        className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-y-0.5"
        strokeWidth={1.8}
      />
      Collapse
    </button>
  );
}

function EventRow({
  event,
  nowMs,
  markerColor,
}: {
  event: EventDto;
  nowMs: number;
  markerColor?: string;
}) {
  // Both vault-local and iCal events route to a detail page. iCal events
  // get a separate route that renders read-only metadata above an editable
  // meeting-notes body (notes are stored in events/<occurrence_id>.md).
  const isIcal = event.provider === "ical";
  // iCal links carry the projected occurrence date so the detail page's
  // "Hide this occurrence" can target THIS row, not the master's start
  // date. Date portion only — TanStack's validateSearch trims it anyway.
  const occurrenceDate = event.date.slice(0, 10);
  const href =
    isIcal && event.accountId && event.externalId
      ? `/cadence/event/ical/${encodeURIComponent(event.accountId)}/${encodeURIComponent(event.externalId)}?date=${occurrenceDate}`
      : `/cadence/event/${event.id}`;
  const isCompleted = eventEndMs(event) <= nowMs;
  return (
    <li
      data-event-state={isCompleted ? "completed" : "upcoming"}
      className="grid min-h-[26px] grid-cols-[auto_3px_minmax(0,1fr)] items-center gap-3"
    >
      <time
        className={cn(
          "font-mono text-[12px] tabular-nums transition-colors",
          isCompleted ? "text-muted-foreground/55" : "text-foreground/75",
        )}
        dateTime={event.date}
      >
        {formatTime(event.date)}
      </time>
      <span
        aria-hidden
        className={cn(
          "h-3 w-[3px] rounded-full transition-colors",
          isCompleted
            ? "bg-muted-foreground/20"
            : markerColor
              ? ""
              : "bg-muted-foreground/30",
        )}
        style={
          markerColor && !isCompleted
            ? { backgroundColor: markerColor }
            : undefined
        }
      />
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to={href}
          // Foreground color at rest; underline arrives on hover. Same
          // pattern as wikilinks — the click affordance is discovered,
          // not advertised, which keeps the schedule reading like
          // content rather than a list of buttons.
          className={cn(
            "min-w-0 truncate text-[13.5px] leading-tight underline-offset-4 decoration-muted-foreground/40 transition-colors hover:underline",
            isCompleted
              ? "text-muted-foreground/60 line-through"
              : "text-foreground",
          )}
        >
          <RichText text={event.title} />
        </Link>
      </div>
    </li>
  );
}

/**
 * Read the persisted collapse override. Absent = follow the per-day default
 * (auto-collapse once the day has wrapped); "true"/"false" = an explicit user
 * choice that holds across day navigation and remounts until they toggle it.
 */
function readScheduleCollapsed(): boolean | null {
  try {
    const stored = window.localStorage.getItem(SCHEDULE_COLLAPSED_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function writeScheduleCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      SCHEDULE_COLLAPSED_STORAGE_KEY,
      collapsed ? "true" : "false",
    );
  } catch {
    // Storage can be unavailable in restricted contexts; the choice still
    // applies to the current session via component state.
  }
}

function useEventCompletionClock(
  events: EventDto[],
  fixedNowMs: number | null,
): number {
  const [nowMs, setNowMs] = useState(() => fixedNowMs ?? Date.now());

  useEffect(() => {
    if (fixedNowMs !== null) {
      setNowMs(fixedNowMs);
      return;
    }
    const current = Date.now();
    const nextEndMs = events.reduce<number | null>((next, event) => {
      const endMs = eventEndMs(event);
      if (endMs <= current) return next;
      return next === null ? endMs : Math.min(next, endMs);
    }, null);

    if (nextEndMs === null) return;

    const delay = Math.min(
      Math.max(nextEndMs - current + 250, 250),
      2_147_483_647,
    );
    const timeout = window.setTimeout(() => setNowMs(Date.now()), delay);
    return () => window.clearTimeout(timeout);
  }, [events, fixedNowMs, nowMs]);

  return nowMs;
}

/** Epoch ms at which an event ends (start + duration). Drives the
 *  "wrapped" check and the sparkline's right edge. */
function eventEndMs(event: EventDto): number {
  return Date.parse(event.date) + (event.duration ?? 0) * 60_000;
}

function formatTime(isoDate: string) {
  return formatClock(Date.parse(isoDate));
}

function formatClock(ms: number) {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}
