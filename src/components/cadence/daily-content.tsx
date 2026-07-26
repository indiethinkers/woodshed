import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { Popover } from "@base-ui/react/popover";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { ScheduleBlock } from "./schedule-block";
import { DailyTasks } from "./task-sidebar";
import { CalendarGrid } from "./date-picker";
import { addMonths, monthStart } from "./date-utils";
import { dailyEditorValue } from "./daily-editor-value";
import { TiptapEditor } from "@/components/shared/tiptap-editor";
import { useDailyJournalMutation } from "@/lib/hooks/use-daily-journal";
import { useToday } from "@/lib/hooks/use-today";

interface DailyContentProps {
  date: string;
  /** Journal body. `null` means the file is still loading — header and
   *  schedule render immediately; the editor area shows a skeleton. */
  body: string | null;
  /** Tauri Cadence keeps tasks in the collapsible inner sidebar. */
  showInlineTasks?: boolean;
}

/**
 * Today view content panel. Composition (top to bottom):
 *
 *   1. Date header  — mono metadata, ruled navigation, oversized date
 *   2. Notes        — freeform editable markdown, autosaves on blur
 *
 * In Tauri the schedule and tasks live in the inner list panel
 * (see `_cadence.tsx`), leaving the content panel as just the date + notes.
 * The non-Tauri/web layout has no list panel, so it renders the schedule and
 * tasks inline here (gated on `showInlineTasks`).
 */
export function DailyContent({
  date,
  body,
  showInlineTasks = true,
}: DailyContentProps) {
  const articleRef = useRef<HTMLElement | null>(null);
  const notesTopFadeRef = useRef<HTMLDivElement | null>(null);
  // `mutateAsync` (not `mutate`) so the returned promise propagates back
  // through TiptapEditor's `onCommit`. The editor's wikilink click handler
  // awaits this before navigating, which is what stops a freshly-typed
  // body from being lost when the user clicks `[[a new page]]` they just
  // wrote and the route changes before the save reaches disk.
  const { mutateAsync: save } = useDailyJournalMutation();

  async function commit(next: string) {
    if (next === body) return;
    await save({ date, body: next, previousBody: body ?? "" });
  }

  const editorBody = body === null ? "" : dailyEditorValue(body);

  // Toggle the notes top-fade imperatively (not via React state) so it tracks
  // the scroll position within the same frame the scroll paints. A layout
  // effect is deliberate: it runs before ContentPanel's own layout effect pins
  // the page to the bottom, so the scroll listener is already attached when
  // that pin fires its scroll event — the fade lands before first paint
  // instead of a render-cycle later, which is what flashed the top notes at
  // full opacity on navigation.
  useLayoutEffect(() => {
    const article = articleRef.current;
    const viewport = article?.closest<HTMLElement>(
      "[data-woodshed-content-scroll]",
    );
    if (!viewport) return;

    const syncFade = () => {
      const fade = notesTopFadeRef.current;
      if (fade) fade.style.opacity = viewport.scrollTop > 1 ? "1" : "0";
    };

    syncFade();
    viewport.addEventListener("scroll", syncFade, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", syncFade);
    };
  }, [date]);

  return (
    <article
      ref={articleRef}
      className="mx-auto flex w-full max-w-detail flex-col"
    >
      <div className="sticky top-4 z-20 isolate -mx-8 bg-content px-8 pt-4 pb-6">
        <div
          className="pointer-events-none absolute inset-x-0 bottom-full h-4 bg-content"
          data-cadence-scroll-shield
          aria-hidden
        />

        <CadenceDayHeader date={date} />

        {/* In Tauri the schedule + tasks live in the inner list panel
            (see _cadence.tsx); the web/non-Tauri layout has no list panel,
            so both render inline here under the same flag. */}
        {showInlineTasks && <ScheduleBlock date={date} />}

        {showInlineTasks && <DailyTasks date={date} />}

        {/* Always mounted; opacity is driven imperatively by the layout effect
            above so it appears in lockstep with the scroll (no React re-render
            lag). opacity-0 base keeps it hidden on the first paint at the top. */}
        <div
          ref={notesTopFadeRef}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-14 translate-y-full bg-gradient-to-b from-content via-content/80 to-content/0 opacity-0 backdrop-blur-[2px] [-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_45%,transparent_100%)] [mask-image:linear-gradient(to_bottom,black_0%,black_45%,transparent_100%)]"
          aria-hidden
        />
      </div>

      {body === null ? (
        // Loading: reserve the editor's resting height with a quiet, static
        // placeholder. The journal read is a fast local file read, so an
        // animated/oversized skeleton just flashes and collapses on resolve;
        // a height-matched empty block makes the load read as "text appears
        // in place". (See plan 008.)
        <div className="min-h-[64px]" aria-hidden />
      ) : (
        /* Notes live in the main page scroll — no inner scroll layer. The
           editor's scroll-past-end runway keeps the active line comfortably
           above the bottom edge on long days. */
        <div className="cursor-text">
          {/* key={date}: /cadence/$date navigations reuse this component
              with new props. A fresh editor per day means a stale doc can
              never blur/flush one day's content into another day's file. */}
          <TiptapEditor
            key={date}
            value={editorBody}
            onCommit={commit}
            mode="outline"
            timestampedListItems
            placeholder="Start writing..."
            className="min-h-[64px] text-[16px] leading-[1.5] text-foreground/85 [&>*+*]:!mt-4"
          />
        </div>
      )}
    </article>
  );
}

function CadenceDayHeader({ date }: { date: string }) {
  const navigate = useNavigate();
  const today = useToday();
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => monthStart(date));

  useEffect(() => {
    if (!open) setViewMonth(monthStart(date));
  }, [date, open]);

  function navigateTo(nextDate: string) {
    setOpen(false);
    void navigate({ href: dayHrefFor(nextDate, today), viewTransition: true });
  }

  const previousDate = addDays(date, -1);
  const nextDate = addDays(date, 1);
  const meta = formatDateMeta(date);
  const isToday = date === today;

  return (
    <header className="mb-6">
      <div className="grid grid-cols-[auto_minmax(4rem,1fr)_auto] items-center gap-7">
        <div className="flex items-center gap-5 whitespace-nowrap font-mono text-[13px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <span>{meta.weekday}</span>
          <span aria-hidden>·</span>
          <span>WK {meta.week}</span>
          <span aria-hidden>·</span>
          <span>DAY {meta.dayOfYear}</span>
        </div>
        <div className="h-px bg-border" aria-hidden />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigateTo(previousDate)}
            aria-label="Previous day"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
          >
            <ChevronLeft className="h-5 w-5" strokeWidth={1.9} />
          </button>
          <button
            type="button"
            onClick={() => navigateTo(today)}
            disabled={isToday}
            aria-disabled={isToday}
            className={
              isToday
                ? "inline-flex h-8 cursor-not-allowed items-center justify-center rounded-md border border-border/60 bg-transparent px-3.5 font-mono text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60"
                : "inline-flex h-8 items-center justify-center rounded-md border border-border bg-background/40 px-3.5 font-mono text-[13px] font-semibold uppercase tracking-[0.08em] text-foreground shadow-[0_1px_0_hsl(0_0%_0%/0.03)] transition-colors hover:bg-background/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
            }
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => navigateTo(nextDate)}
            aria-label="Next day"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
          >
            <ChevronRight className="h-5 w-5" strokeWidth={1.9} />
          </button>
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger
              aria-label="Open date picker"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
            >
              <CalendarDays className="h-5 w-5" strokeWidth={1.9} />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner className="z-50" sideOffset={8} align="end">
                <Popover.Popup className="w-[280px] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none">
                  <CalendarGrid
                    viewMonth={viewMonth}
                    selected={date}
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
        </div>
      </div>

      <h1 className="mt-6 text-[32px] font-bold leading-none tracking-normal text-foreground">
        {formatDateTitle(date)}
      </h1>
    </header>
  );
}

function formatDateTitle(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  const month = d.toLocaleDateString("en-US", { month: "long" });
  const day = d.getDate();
  const year = d.getFullYear();
  return `${month} ${day}, ${year}`;
}

function formatDateMeta(dateStr: string) {
  const d = parseDate(dateStr);
  return {
    weekday: d.toLocaleDateString("en-US", { weekday: "long" }),
    week: getIsoWeek(d),
    dayOfYear: getZeroBasedDayOfYear(d),
  };
}

function parseDate(dateStr: string) {
  return new Date(dateStr + "T00:00:00");
}

function addDays(dateStr: string, n: number): string {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

function dayHrefFor(date: string, today: string): string {
  return date === today ? "/" : `/cadence/${date}`;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getZeroBasedDayOfYear(date: Date): number {
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((current - start) / 86_400_000);
}

function getIsoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}
