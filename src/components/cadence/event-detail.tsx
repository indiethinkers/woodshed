import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { FilePathLine } from "@/components/shared/file-path-pill";
import { BacklinksPanel } from "@/components/shared/backlinks-panel";
import { OutgoingLinksPanel } from "@/components/shared/outgoing-links-panel";
import { TagEditor } from "@/components/shared/tag-editor";
import { TiptapEditor } from "@/components/shared/tiptap-editor";
import {
  EmptyValue,
  PickerPropertyValue,
  PropertyList,
  PropertyRow,
} from "@/components/shared/property-list";
import { Separator } from "@/components/ui/separator";
import { AttendeeChip, AttendeePicker } from "./attendees";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAreas } from "@/lib/hooks/use-areas";
import { useToday } from "@/lib/hooks/use-today";
import type { RecurringRule } from "@/lib/types";
import {
  useEvent,
  useEventMutations,
  type EventDto,
} from "@/lib/hooks/use-events";
import { combineDateTime } from "./datetime-utils";
import { DateTimeDurationField } from "./event-fields";

// Vault-local event detail. Same property-list pattern the rest of the
// detail-page family uses. Recurring uses the small enum picker; the date
// + time + duration popover (existing DateTimeDurationField) drops into a
// property row as-is. Attendees render as wikilinks resolved to People
// records when possible, falling back to the raw id string.

interface EventDetailProps {
  id: string;
}

const RECURRING_OPTIONS: { value: RecurringRule; label: string }[] = [
  { value: "none", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

export function EventDetail({ id }: EventDetailProps) {
  const { data: event, isLoading } = useEvent(id);

  // Render as soon as we have an event — the schedule list seeds this via
  // `placeholderData`, so navigating in from a row paints real content on
  // the first frame. The skeleton is only for a cold deep-link.
  if (event) {
    return <EventDetailInner event={event} />;
  }
  if (isLoading) {
    return <EventSkeleton />;
  }
  return (
    <article className="w-full">
      <p className="text-sm text-muted-foreground">Event not found.</p>
    </article>
  );
}

function EventSkeleton() {
  return (
    <article className="w-full animate-pulse">
      <div className="h-8 w-3/4 bg-muted rounded mb-8" />
      <div className="space-y-2 mb-10">
        <div className="h-4 w-1/2 bg-muted rounded" />
        <div className="h-4 w-1/3 bg-muted rounded" />
        <div className="h-4 w-2/5 bg-muted rounded" />
      </div>
      <div className="space-y-3 max-w-prose">
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-2/3 bg-muted rounded" />
      </div>
    </article>
  );
}

function EventDetailInner({ event }: { event: EventDto }) {
  const { update, remove } = useEventMutations();
  const { data: areas = [] } = useAreas();
  const navigate = useNavigate();
  const today = useToday();

  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(event.title);

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
    update.mutate({ id: event.id, update: { title: next } });
  }

  function cancelTitle() {
    setTitleDraft(event.title);
    setTitleEditing(false);
  }

  // `mutateAsync` (not `mutate`) so TiptapEditor's wikilink click handler
  // can await the save before navigating. Otherwise unsaved edits get
  // stranded by an immediate route change. See use-daily-journal.ts.
  async function commitBody(next: string) {
    if (next === event.body) return;
    await update.mutateAsync({ id: event.id, update: { body: next } });
  }

  function commitArea(next: string) {
    if (next === event.area) return;
    update.mutate({ id: event.id, update: { area: next } });
  }

  function commitRecurring(next: RecurringRule) {
    if (next === event.recurring) return;
    update.mutate({ id: event.id, update: { recurring: next } });
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
    update.mutate({ id: event.id, update: patch });
  }

  function commitTags(next: string[]) {
    update.mutate({ id: event.id, update: { tags: next } });
  }

  function handleDelete() {
    // Route to the deleted event's own day, not wherever history happens to
    // point (the user may have deep-linked straight to the event). Match the
    // app convention: today canonicalizes to "/", any other date to /cadence/<date>.
    const dateStr = event.date.slice(0, 10);
    const href = dateStr === today ? "/" : `/cadence/${dateStr}`;
    remove.mutate(
      { id: event.id, retainDetail: true },
      { onSuccess: () => void navigate({ href, replace: true }) },
    );
  }

  return (
    <div className="w-full max-w-[768px]">
      <header className="mb-8">
        <div className="flex items-start justify-between gap-4">
          {titleEditing ? (
            <TitleInput
              value={titleDraft}
              onChange={setTitleDraft}
              onCommit={commitTitle}
              onCancel={cancelTitle}
            />
          ) : (
            <h1
              className="flex-1 min-w-0 text-[28px] font-semibold tracking-[-0.02em] leading-[1.2] cursor-text -mx-1 px-1 rounded-sm hover:bg-foreground/[0.03] transition-colors"
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
          )}
          <div className="flex shrink-0 items-center gap-2">
            <MoreMenu onDelete={handleDelete} eventTitle={event.title} />
          </div>
        </div>
        <FilePathLine className="mt-1.5" />
      </header>

      <PropertyList>
        <PropertyRow label="When">
          <DateTimeDurationField event={event} onCommit={commitDateTimeDuration} />
        </PropertyRow>
        <PropertyRow label="Area">
          <PickerPropertyValue
            value={event.area}
            options={areas.map((a) => ({ value: a.id, label: a.name }))}
            onCommit={commitArea}
          />
        </PropertyRow>
        <PropertyRow label="Recurring">
          <PickerPropertyValue
            value={event.recurring}
            options={RECURRING_OPTIONS}
            onCommit={commitRecurring}
          />
        </PropertyRow>
        {event.subtitle && (
          // Calendar providers use the subtitle for a location or secondary
          // line. Render it as a property so it shares the same column rhythm
          // as the rest of the page.
          <PropertyRow label="Location">
            <span className="text-foreground/85">{event.subtitle}</span>
          </PropertyRow>
        )}
        <PropertyRow label="Attendees">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {event.resolvedAttendees.length === 0 && <EmptyValue />}
            {event.resolvedAttendees.map((attendee, idx) => (
              <AttendeeChip
                key={`${attendee.raw}-${idx}`}
                attendee={attendee}
                onRemove={() => {
                  const next = event.attendees.filter(
                    (raw, i) => !(raw === attendee.raw && i === idx),
                  );
                  update.mutate({
                    id: event.id,
                    update: { attendees: next },
                  });
                }}
              />
            ))}
            <AttendeePicker
              exclude={event.attendees}
              onPick={(personId) => {
                if (event.attendees.includes(personId)) return;
                update.mutate({
                  id: event.id,
                  update: { attendees: [...event.attendees, personId] },
                });
              }}
            />
          </div>
        </PropertyRow>
        <PropertyRow label="Tags">
          <TagEditor tags={event.tags ?? []} onCommit={commitTags} />
        </PropertyRow>
      </PropertyList>

      <Separator className="mt-8" />

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
          // Recorded meeting transcripts append as a collapsible <details>
          // HTML block; allow HTML so it folds instead of showing raw tags.
          allowHtml
          placeholder="Start writing..."
          className="text-[15px] leading-normal text-foreground min-h-[120px]"
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
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
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
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
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
  onDelete,
  eventTitle,
}: {
  onDelete: () => void;
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
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
        {confirming ? (
          <DropdownMenuItem
            onClick={onDelete}
            className="text-destructive focus:text-destructive flex items-center gap-2 text-[14px] cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Yes, delete
          </DropdownMenuItem>
        ) : (
          // closeOnClick={false}: Base UI Menu ignores e.preventDefault() in
          // user onClick and closes anyway, which would immediately flip
          // confirming back to false via onOpenChange.
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => setConfirming(true)}
            className="text-destructive focus:text-destructive flex items-center gap-2 text-[14px] cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete event…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
