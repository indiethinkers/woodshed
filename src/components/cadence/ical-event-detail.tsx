import { useEffect, useRef, useState } from "react";
import { EyeOff, ExternalLink, MoreHorizontal, Video } from "lucide-react";
import { FilePathLine } from "@/components/shared/file-path-pill";
import { ExternalAnchor } from "@/components/shared/external-link";
import { BacklinksPanel } from "@/components/shared/backlinks-panel";
import { OutgoingLinksPanel } from "@/components/shared/outgoing-links-panel";
import { TiptapEditor } from "@/components/shared/tiptap-editor";
import {
  EmptyValue,
  PickerPropertyValue,
  PropertyList,
  PropertyRow,
} from "@/components/shared/property-list";
import { Separator } from "@/components/ui/separator";
import { AttendeeChip } from "./attendees";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAreas } from "@/lib/hooks/use-areas";
import {
  useIcalEvent,
  useIcalEventSaveNotes,
  type EventDto,
} from "@/lib/hooks/use-events";
import { useIcalEventDismiss } from "@/lib/hooks/use-gcal";
import { combineDateTime } from "./datetime-utils";
import { DateTimeDurationField } from "./event-fields";

// iCal events live in the gcal-cache, NOT as vault files. Title / time /
// duration / notes-body are all editable, but edits land in a local
// occurrence file at `events/<occurrence_id>.md` and do NOT write back to
// the source calendar (Phase 2b OAuth would handle bidirectional sync).
// The override file's metadata wins over the cache on read, so local
// edits survive the next sync — but Google still has the original. We
// surface a "Modified locally" hint so the divergence from upstream is
// visible.

interface IcalEventDetailProps {
  accountId: string;
  externalId: string;
  /**
   * Date of the specific occurrence the user navigated from, in
   * `YYYY-MM-DD` form. Only meaningful for recurring events — the
   * cache returns the master event's start date, so without this
   * param "Hide this occurrence" would dismiss the master and miss
   * every other projection. Falls back to the event's stored date
   * when absent (non-recurring case, or a deep-linked open).
   */
  occurrenceDate?: string;
}

export function IcalEventDetail({
  accountId,
  externalId,
  occurrenceDate,
}: IcalEventDetailProps) {
  const { data: event, isLoading } = useIcalEvent(
    accountId,
    externalId,
    occurrenceDate,
  );

  // Render as soon as we have an event — the schedule list seeds this via
  // `placeholderData`, so navigating in from a row paints real content on
  // the first frame. The skeleton is only for a cold deep-link.
  if (event) {
    return <IcalEventInner event={event} occurrenceDate={occurrenceDate} />;
  }
  if (isLoading) {
    return <IcalEventSkeleton />;
  }
  return (
    <article className="w-full">
      <p className="text-sm text-muted-foreground">
        This calendar event is no longer in the cache. Re-sync the calendar
        from <span className="text-foreground">Settings → Accounts</span> to
        bring it back.
      </p>
    </article>
  );
}

function IcalEventSkeleton() {
  return (
    <article className="w-full animate-pulse">
      <div className="h-8 w-3/4 bg-muted rounded mb-8" />
      <div className="space-y-2 mb-10">
        <div className="h-4 w-1/2 bg-muted rounded" />
        <div className="h-4 w-2/5 bg-muted rounded" />
      </div>
      <div className="space-y-3 max-w-prose">
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-2/3 bg-muted rounded" />
      </div>
    </article>
  );
}

function IcalEventInner({
  event,
  occurrenceDate,
}: {
  event: EventDto;
  occurrenceDate?: string;
}) {
  const save = useIcalEventSaveNotes();
  const dismiss = useIcalEventDismiss();
  const { data: areas = [] } = useAreas();
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(event.title);
  const accountId = event.accountId ?? "";
  const externalId = event.externalId ?? "";

  useEffect(() => {
    if (!titleEditing) setTitleDraft(event.title);
  }, [event.title, titleEditing]);

  function commitTitle() {
    const next = titleDraft.trim();
    setTitleEditing(false);
    if (!next || next === event.title) {
      setTitleDraft(event.title);
      return;
    }
    save.mutate({ accountId, externalId, occurrenceDate, title: next });
  }

  // `mutateAsync` (not `mutate`) so TiptapEditor's wikilink click handler
  // can await the save before navigating. Otherwise unsaved edits get
  // stranded by an immediate route change. See use-daily-journal.ts.
  async function commitBody(next: string) {
    if (next === event.body) return;
    await save.mutateAsync({ accountId, externalId, occurrenceDate, body: next });
  }

  function commitDateTimeDuration(next: {
    date: string;
    time: string;
    duration: number;
  }) {
    const iso = combineDateTime(next.date, next.time);
    const patch: { date?: string; duration?: number } = {};
    if (iso !== event.date) patch.date = iso;
    if (next.duration !== event.duration) patch.duration = next.duration;
    if (!patch.date && !patch.duration) return;
    save.mutate({ accountId, externalId, occurrenceDate, ...patch });
  }

  function commitArea(next: string) {
    if (next === event.area) return;
    save.mutate({ accountId, externalId, occurrenceDate, area: next });
  }

  function handleHide() {
    // For recurring events, `event.date` is the master's start (the
    // first occurrence ever) — dismissing that misses the row the
    // user actually clicked. The schedule-block link carries the
    // projected occurrence date in `?date=`; use that when present
    // so per-occurrence hides work for recurring series.
    const dismissDate = occurrenceDate ?? event.date;
    dismiss.mutate(
      { accountId, externalId, occurrenceDate: dismissDate },
      {
        // The per-occurrence dismiss leaves the URL still resolvable
        // (event_ical_get only blocks legacy whole-UID dismissals), so
        // navigating back avoids the awkward "you just hid the page
        // you're on" state without the empty-state fallback.
        onSuccess: () => window.history.back(),
      },
    );
  }

  const brand = event.meetingUrl ? brandFor(event.meetingUrl) : null;

  return (
    <div className="w-full max-w-[768px]">
      <header className="mb-8 flex items-start justify-between gap-4">
        {titleEditing ? (
          <div className="flex-1 min-w-0">
            <TitleInput
              value={titleDraft}
              onChange={setTitleDraft}
              onCommit={commitTitle}
            />
            <FilePathLine className="mt-1.5" />
          </div>
        ) : (
          <div className="flex-1 min-w-0">
            <h1
              className="text-[28px] font-semibold tracking-[-0.02em] leading-[1.2] cursor-text -mx-1 px-1 rounded-sm hover:bg-foreground/[0.03] transition-colors"
              onClick={() => setTitleEditing(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setTitleEditing(true);
                }
              }}
            >
              {event.title}
            </h1>
            <FilePathLine className="mt-1.5" />
            {event.localOverrides && (
              // Visible cue that the displayed metadata diverges from the
              // upstream Google Calendar entry. Source row in Google still
              // has the original values; our sync won't overwrite the
              // local edit.
              <p className="mt-1.5 font-mono text-[11px] text-muted-foreground/80">
                modified locally · doesn't sync to Google
              </p>
            )}
          </div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          <MoreMenu onHide={handleHide} eventTitle={event.title} />
        </div>
      </header>

      <PropertyList>
        <PropertyRow label="When">
          <DateTimeDurationField event={event} onCommit={commitDateTimeDuration} />
        </PropertyRow>
        <PropertyRow label="Area">
          {/* iCal events arrive with no upstream `area`; the picker lets
              the user pin one locally. The choice persists in the overlay
              file at events/<occurrence_id>.md and stays put through
              re-syncs. */}
          <PickerPropertyValue
            value={event.area}
            options={areas.map((a) => ({ value: a.id, label: a.name }))}
            onCommit={commitArea}
          />
        </PropertyRow>
        {event.subtitle && !event.meetingUrl && (
          // Hide the raw LOCATION when it's just the meeting URL — the
          // Join button below already surfaces it. Keep it when the
          // location is a physical address ("Conference Room B").
          <PropertyRow label="Location">
            <span className="text-foreground/85">{event.subtitle}</span>
          </PropertyRow>
        )}
        <PropertyRow label="Attendees">
          {event.resolvedAttendees.length === 0 ? (
            <EmptyValue />
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
              {event.resolvedAttendees.map((attendee, idx) => (
                <AttendeeChip
                  key={`${attendee.raw}-${idx}`}
                  attendee={attendee}
                />
              ))}
            </div>
          )}
        </PropertyRow>
      </PropertyList>

      <Separator className="mt-8" />

      {event.meetingUrl && brand && (
        <ExternalAnchor
          href={event.meetingUrl}
          className="inline-flex items-center gap-1.5 mt-6 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <Video className="h-3.5 w-3.5" />
          <span>Join {brand.label}</span>
          <ExternalLink className="h-3 w-3 opacity-70" />
        </ExternalAnchor>
      )}

      {event.description && (
        <details className="mt-8 group max-w-prose">
          <summary className="font-mono text-[13px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors list-none flex items-center gap-1.5 select-none">
            <span className="group-open:rotate-90 transition-transform inline-block">
              ›
            </span>
            <span>Event description</span>
          </summary>
          <div className="mt-3 text-[14px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
            <DescriptionWithLinks text={event.description} />
          </div>
        </details>
      )}

      <div className="mt-8 max-w-prose">
        {/* key={event.id}: event→event navigation reuses this component, and
            a carried-over editor instance could flush one event's notes into
            another event's file. A fresh editor per record can't. */}
        <TiptapEditor
          key={event.id}
          value={event.body}
          onCommit={commitBody}
          focusOnEnter
          unwrapOutlineOnLoad
          scrollPastEnd={false}
          // See event-detail.tsx: fold recorded meeting transcripts.
          allowHtml
          placeholder="Start writing..."
          className="text-[15px] leading-normal text-foreground min-h-[160px]"
        />
      </div>

      <OutgoingLinksPanel sourceId={event.id} />
      <BacklinksPanel targetId={event.id} />
    </div>
  );
}

function TitleInput({
  value,
  onChange,
  onCommit,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          onCommit();
        }
      }}
      // h-[1.2em] pins the input to the h1's exact line box — WebKit
      // ignores line-height on single-line inputs and would otherwise size
      // it from the font's natural metrics, shifting the content below.
      className="flex-1 min-w-0 h-[1.2em] text-[28px] font-semibold tracking-[-0.02em] leading-[1.2] bg-transparent outline-none focus:outline-none -mx-1 px-1 rounded-sm focus:bg-foreground/[0.03]"
    />
  );
}

function MoreMenu({
  onHide,
  eventTitle,
}: {
  onHide: () => void;
  eventTitle: string;
}) {
  const [confirming, setConfirming] = useState(false);
  function handleOpenChange(open: boolean) {
    if (!open) setConfirming(false);
  }
  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        aria-label={`More actions for ${eventTitle}`}
        className="h-7 w-7 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 data-[popup-open]:bg-foreground/[0.05] data-[popup-open]:text-foreground shrink-0"
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-48">
        {confirming ? (
          <DropdownMenuItem
            onClick={onHide}
            className="flex items-center gap-2 text-[14px] cursor-pointer"
          >
            <EyeOff className="h-3.5 w-3.5" />
            Yes, hide this occurrence
          </DropdownMenuItem>
        ) : (
          // closeOnClick={false}: Base UI Menu ignores e.preventDefault() in
          // user onClick and closes anyway, which would immediately flip
          // confirming back to false via onOpenChange.
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => setConfirming(true)}
            className="flex items-center gap-2 text-[14px] cursor-pointer"
          >
            <EyeOff className="h-3.5 w-3.5" />
            Hide from Woodshed…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Provider label + brand color for the Join button. Brand hexes match
// each provider's published primary color so the button reads as their
// own CTA. Backgrounds are saturated enough that white text passes
// contrast at the 32px button height.
function brandFor(url: string): { label: string; bg: string } | null {
  const lower = url.toLowerCase();
  if (lower.includes("zoom.us")) return { label: "Zoom", bg: "#2D8CFF" };
  if (lower.includes("meet.google.com"))
    return { label: "Google Meet", bg: "#00832D" };
  if (lower.includes("meet.jit.si")) return { label: "Jitsi", bg: "#1B61A6" };
  if (lower.includes("teams.microsoft.com") || lower.includes("teams.live.com"))
    return { label: "Teams", bg: "#5059C9" };
  if (lower.includes("webex.com")) return { label: "Webex", bg: "#0091B0" };
  if (lower.includes("whereby.com")) return { label: "Whereby", bg: "#4F00CD" };
  return null;
}

// Linkify any http(s) URL in the cleaned description text. The backend
// has already stripped HTML and unwrapped Google redirects, so this is
// just turning bare URLs into clickable anchors.
function DescriptionWithLinks({ text }: { text: string }) {
  const parts: Array<{ kind: "text" | "url"; value: string }> = [];
  const re = /(https?:\/\/[^\s<>"]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ kind: "text", value: text.slice(last, m.index) });
    }
    parts.push({ kind: "url", value: m[1] });
    last = m.index + m[1].length;
  }
  if (last < text.length) {
    parts.push({ kind: "text", value: text.slice(last) });
  }
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "url" ? (
          <ExternalAnchor
            key={i}
            href={p.value}
            className="text-foreground underline underline-offset-2 decoration-muted-foreground/40 hover:decoration-foreground break-all"
          >
            {p.value}
          </ExternalAnchor>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </>
  );
}
