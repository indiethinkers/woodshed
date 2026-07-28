import { useMemo, type ElementType, type MouseEvent } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  CalendarDays,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileQuestion,
  FileText,
  Library,
  Mail,
  MapPinned,
  PanelRightClose,
  Plus,
  Table2,
  Users,
  X,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Markdown } from "@/components/shared/markdown";
import { ExternalAnchor } from "@/components/shared/external-link";
import { useDailyJournal } from "@/lib/hooks/use-daily-journal";
import { useAreas } from "@/lib/hooks/use-areas";
import { useEvent, useIcalEvent } from "@/lib/hooks/use-events";
import { useEmail } from "@/lib/hooks/use-mail";
import { useNote } from "@/lib/hooks/use-notes";
import { usePerson } from "@/lib/hooks/use-people";
import { useResource } from "@/lib/hooks/use-resources";
import { useRow, useTable, type CellValue } from "@/lib/hooks/use-tables";
import { useTask } from "@/lib/hooks/use-tasks";
import { useToday } from "@/lib/hooks/use-today";
import {
  useRightSidebar,
  type RightSidebarEntry,
} from "./right-sidebar-context-internal";
import { isSameReferencePage } from "./right-sidebar-route";

type ReferenceTarget =
  | { kind: "area"; id: string }
  | { kind: "daily"; date: string | null }
  | { kind: "event"; id: string }
  | {
      kind: "ical-event";
      accountId: string;
      externalId: string;
      occurrenceDate?: string;
    }
  | { kind: "mail"; id: string }
  | { kind: "note"; id: string }
  | { kind: "person"; id: string }
  | { kind: "resource"; id: string }
  | { kind: "row"; tableId: string; rowId: string }
  | { kind: "table"; id: string }
  | { kind: "task"; id: string }
  | { kind: "unsupported"; href: string };

const icons: Record<Exclude<ReferenceTarget["kind"], "unsupported">, ElementType> = {
  area: MapPinned,
  daily: CalendarDays,
  event: CalendarDays,
  "ical-event": CalendarDays,
  mail: Mail,
  note: FileText,
  person: Users,
  resource: Library,
  row: Table2,
  table: Table2,
  task: CheckSquare2,
};

export function RightSidebarPanel() {
  const { open, entries, addPage, closeSidebar } = useRightSidebar();
  const currentHref = useRouterState({ select: (state) => state.location.href });

  if (!open) return null;

  function openPicker() {
    window.dispatchEvent(
      new CustomEvent("woodshed:open-palette", {
        detail: { mode: "right-sidebar" },
      }),
    );
  }

  function onClickCapture(event: MouseEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor) return;
    if (anchor.closest("[data-reference-main-link]")) return;
    if (anchor.target === "_blank") return;

    const rawHref = anchor.getAttribute("href");
    if (!rawHref || rawHref.startsWith("#")) return;

    let url: URL;
    try {
      url = new URL(rawHref, window.location.origin);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;

    event.preventDefault();
    event.stopPropagation();
    addPage({
      href: `${url.pathname}${url.search}${url.hash}`,
      title: anchor.textContent?.trim() || undefined,
    });
  }

  return (
    <aside
      className="flex h-full w-[clamp(520px,40vw,820px)] max-w-[50vw] shrink-0 flex-col overflow-hidden border-l border-border bg-list"
      data-woodshed-surface="right-sidebar"
      onClickCapture={onClickCapture}
    >
      <header className="flex h-[52px] shrink-0 items-center justify-end gap-2 border-b border-border/70 px-3">
        {entries.length > 0 && (
          <span className="mr-auto inline-flex h-5 min-w-5 items-center justify-center rounded-pill border border-border bg-background/35 px-1.5 font-mono text-[11px] text-muted-foreground">
            {entries.length}
          </span>
        )}
        <button
          type="button"
          onClick={openPicker}
          title="Add page"
          aria-label="Add page"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <Plus className="h-4 w-4" strokeWidth={1.85} />
        </button>
        <button
          type="button"
          onClick={closeSidebar}
          title="Close right sidebar (⌘/)"
          aria-label="Close right sidebar"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <PanelRightClose className="h-4 w-4" strokeWidth={1.85} />
        </button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {entries.length === 0 ? (
          <div aria-hidden className="h-full" />
        ) : (
          <div className="pb-6">
            {entries.map((entry) => (
              <ReferenceEntry
                key={entry.id}
                currentHref={currentHref}
                entry={entry}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
}

function ReferenceEntry({
  currentHref,
  entry,
}: {
  currentHref: string;
  entry: RightSidebarEntry;
}) {
  const { removePage, toggleEntry } = useRightSidebar();
  const target = useMemo(() => parseReferenceHref(entry.href), [entry.href]);
  const isOpenInMain = isSameReferencePage(entry.href, currentHref);
  const Icon =
    target.kind === "unsupported" ? FileQuestion : icons[target.kind];

  return (
    <Collapsible
      open={entry.expanded}
      onOpenChange={() => toggleEntry(entry.id)}
    >
      <section className="border-b border-border/70">
        <div className="flex min-w-0 items-center gap-1 bg-foreground/[0.025] px-3 py-2">
          <CollapsibleTrigger className="group flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left transition-colors hover:bg-foreground/[0.04]">
            {entry.expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">
              {entry.title}
            </span>
          </CollapsibleTrigger>
          <button
            type="button"
            onClick={() => removePage(entry.id)}
            title={`Remove ${entry.title}`}
            aria-label={`Remove ${entry.title}`}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.85} />
          </button>
        </div>
        <CollapsibleContent>
          {isOpenInMain ? (
            <ActiveMainReference href={entry.href} />
          ) : (
            <ReferencePage href={entry.href} target={target} />
          )}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function ActiveMainReference({ href }: { href: string }) {
  return (
    <div className="px-4 pb-5 pt-4">
      <div className="mb-3 font-mono text-[10.5px] text-muted-foreground">
        {href}
      </div>
      <p className="text-[13px] leading-6 text-muted-foreground">
        This page is open in the main pane.
      </p>
    </div>
  );
}

function ReferencePage({
  href,
  target,
}: {
  href: string;
  target: ReferenceTarget;
}) {
  switch (target.kind) {
    case "area":
      return <AreaReference id={target.id} href={href} />;
    case "daily":
      return <DailyReference date={target.date} href={href} />;
    case "event":
      return <EventReference id={target.id} href={href} />;
    case "ical-event":
      return (
        <IcalEventReference
          accountId={target.accountId}
          externalId={target.externalId}
          occurrenceDate={target.occurrenceDate}
          href={href}
        />
      );
    case "mail":
      return <MailReference id={target.id} href={href} />;
    case "note":
      return <NoteReference id={target.id} href={href} />;
    case "person":
      return <PersonReference id={target.id} href={href} />;
    case "resource":
      return <ResourceReference id={target.id} href={href} />;
    case "row":
      return (
        <RowReference
          tableId={target.tableId}
          rowId={target.rowId}
          href={href}
        />
      );
    case "table":
      return <TableReference id={target.id} href={href} />;
    case "task":
      return <TaskReference id={target.id} href={href} />;
    case "unsupported":
      return <UnsupportedReference href={target.href} />;
  }
}

function NoteReference({ id, href }: { id: string; href: string }) {
  const { data: note, isLoading } = useNote(id);
  if (isLoading) return <ReferenceLoading />;
  if (!note) return <ReferenceMissing label="Note not found." href={href} />;

  return (
    <ReferenceDocument href={href}>
      <ReferenceFields>
        <ReferenceField label="Created">{formatDate(note.created)}</ReferenceField>
        {note.area && <ReferenceField label="Area">{note.area}</ReferenceField>}
        {note.tags.length > 0 && (
          <ReferenceField label="Tags">{note.tags.join(", ")}</ReferenceField>
        )}
      </ReferenceFields>
      <ReferenceMarkdown text={note.body} />
    </ReferenceDocument>
  );
}

function ResourceReference({ id, href }: { id: string; href: string }) {
  const { data: resource, isLoading } = useResource(id);
  if (isLoading) return <ReferenceLoading />;
  if (!resource) return <ReferenceMissing label="Resource not found." href={href} />;

  return (
    <ReferenceDocument href={href}>
      <ReferenceFields>
        {resource.url && (
          <ReferenceField label="Source">
            <ExternalAnchor
              href={resource.url}
              className="inline-flex min-w-0 items-center gap-1 text-foreground underline-offset-2 hover:underline"
            >
              <span className="truncate">{resource.source || resource.url}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            </ExternalAnchor>
          </ReferenceField>
        )}
        <ReferenceField label="Saved">{formatDate(resource.saved)}</ReferenceField>
        {resource.author && (
          <ReferenceField label="Author">{resource.author}</ReferenceField>
        )}
        {resource.tags.length > 0 && (
          <ReferenceField label="Tags">{resource.tags.join(", ")}</ReferenceField>
        )}
      </ReferenceFields>
      {resource.highlights.length > 0 && (
        <section className="mb-5 space-y-2">
          <ReferenceLabel>Highlights</ReferenceLabel>
          {resource.highlights.map((highlight, index) => (
            <blockquote
              key={index}
              className="border-l border-border pl-3 text-[13px] leading-6 text-muted-foreground"
            >
              &ldquo;{highlight}&rdquo;
            </blockquote>
          ))}
        </section>
      )}
      <ReferenceMarkdown text={resource.body} />
    </ReferenceDocument>
  );
}

function PersonReference({ id, href }: { id: string; href: string }) {
  const { data: person, isLoading } = usePerson(id);
  if (isLoading) return <ReferenceLoading />;
  if (!person) return <ReferenceMissing label="Person not found." href={href} />;

  return (
    <ReferenceDocument href={href}>
      <ReferenceFields>
        {person.role && <ReferenceField label="Role">{person.role}</ReferenceField>}
        {person.company && (
          <ReferenceField label="Company">{person.company}</ReferenceField>
        )}
        {person.email && (
          <ReferenceField label="Email">
            <a
              href={`mailto:${person.email}`}
              className="truncate text-foreground underline-offset-2 hover:underline"
            >
              {person.email}
            </a>
          </ReferenceField>
        )}
        {person.relationship && (
          <ReferenceField label="Relationship">
            {person.relationship}
          </ReferenceField>
        )}
      </ReferenceFields>
      <ReferenceMarkdown text={person.body} />
    </ReferenceDocument>
  );
}

function DailyReference({
  date,
  href,
}: {
  date: string | null;
  href: string;
}) {
  const today = useToday();
  const resolvedDate = date ?? today;
  const { data: journal, isLoading } = useDailyJournal(resolvedDate);
  if (isLoading) return <ReferenceLoading />;

  return (
    <ReferenceDocument href={href === "/" ? `/cadence/${resolvedDate}` : href}>
      <ReferenceFields>
        <ReferenceField label="Date">{formatDate(resolvedDate)}</ReferenceField>
      </ReferenceFields>
      <ReferenceMarkdown text={journal?.body ?? ""} empty="No journal notes yet." />
    </ReferenceDocument>
  );
}

function EventReference({ id, href }: { id: string; href: string }) {
  const { data: event, isLoading } = useEvent(id);
  if (isLoading) return <ReferenceLoading />;
  if (!event) return <ReferenceMissing label="Event not found." href={href} />;
  return <ResolvedEventReference event={event} href={href} />;
}

function IcalEventReference({
  accountId,
  externalId,
  occurrenceDate,
  href,
}: {
  accountId: string;
  externalId: string;
  occurrenceDate?: string;
  href: string;
}) {
  const { data: event, isLoading } = useIcalEvent(
    accountId,
    externalId,
    occurrenceDate,
  );
  if (isLoading) return <ReferenceLoading />;
  if (!event) return <ReferenceMissing label="Event not found." href={href} />;
  return <ResolvedEventReference event={event} href={href} />;
}

function ResolvedEventReference({
  event,
  href,
}: {
  event: {
    title: string;
    date: string;
    duration: number;
    area?: string;
    resolvedAttendees?: { name: string; email?: string }[];
    description?: string;
    meetingUrl?: string;
    body: string;
  };
  href: string;
}) {
  const attendees = event.resolvedAttendees ?? [];
  return (
    <ReferenceDocument href={href}>
      <ReferenceFields>
        <ReferenceField label="When">{formatDateTime(event.date)}</ReferenceField>
        <ReferenceField label="Duration">{event.duration} min</ReferenceField>
        {event.area && <ReferenceField label="Area">{event.area}</ReferenceField>}
        {attendees.length > 0 && (
          <ReferenceField label="Attendees">
            {attendees.map((attendee) => attendee.name).join(", ")}
          </ReferenceField>
        )}
        {event.meetingUrl && (
          <ReferenceField label="Meeting">
            <ExternalAnchor
              href={event.meetingUrl}
              className="inline-flex min-w-0 items-center gap-1 text-foreground underline-offset-2 hover:underline"
            >
              <span className="truncate">Join meeting</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            </ExternalAnchor>
          </ReferenceField>
        )}
      </ReferenceFields>
      {event.description && (
        <section className="mb-5">
          <ReferenceLabel>Description</ReferenceLabel>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-muted-foreground">
            {event.description}
          </p>
        </section>
      )}
      <ReferenceMarkdown text={event.body} empty="No meeting notes yet." />
    </ReferenceDocument>
  );
}

function TaskReference({ id, href }: { id: string; href: string }) {
  const { data: task, isLoading } = useTask(id);
  if (isLoading) return <ReferenceLoading />;
  if (!task) return <ReferenceMissing label="Task not found." href={href} />;

  return (
    <ReferenceDocument href={href}>
      <ReferenceFields>
        <ReferenceField label="Status">{task.status}</ReferenceField>
        <ReferenceField label="Area">{task.area}</ReferenceField>
        {task.scheduled && (
          <ReferenceField label="Scheduled">{formatDate(task.scheduled)}</ReferenceField>
        )}
        {task.tags.length > 0 && (
          <ReferenceField label="Tags">{task.tags.join(", ")}</ReferenceField>
        )}
      </ReferenceFields>
      <ReferenceMarkdown text={task.body} empty="No task notes yet." />
    </ReferenceDocument>
  );
}

function TableReference({ id, href }: { id: string; href: string }) {
  const { data: table, isLoading } = useTable(id);
  if (isLoading) return <ReferenceLoading />;
  if (!table) return <ReferenceMissing label="Table not found." href={href} />;

  return (
    <ReferenceDocument href={href}>
      <ReferenceFields>
        <ReferenceField label="Created">{formatDate(table.created)}</ReferenceField>
        <ReferenceField label="Columns">{table.columns.length}</ReferenceField>
        <ReferenceField label="Views">{table.views.length}</ReferenceField>
      </ReferenceFields>
      <section className="space-y-2">
        <ReferenceLabel>Columns</ReferenceLabel>
        <ul className="space-y-1 text-[13px] leading-5 text-foreground/85">
          {table.columns.map((column) => (
            <li key={column.id} className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{column.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {column.type}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </ReferenceDocument>
  );
}

function RowReference({
  tableId,
  rowId,
  href,
}: {
  tableId: string;
  rowId: string;
  href: string;
}) {
  const { data: table, isLoading: tableLoading } = useTable(tableId);
  const { data: row, isLoading: rowLoading } = useRow(tableId, rowId);
  if (tableLoading || rowLoading) return <ReferenceLoading />;
  if (!table || !row) return <ReferenceMissing label="Row not found." href={href} />;

  return (
    <ReferenceDocument href={href}>
      <ReferenceFields>
        <ReferenceField label="Table">{table.name}</ReferenceField>
        <ReferenceField label="Created">{formatDate(row.created)}</ReferenceField>
        {table.columns.map((column) => (
          <ReferenceField key={column.id} label={column.name}>
            {formatCellValue(row.cells[column.id])}
          </ReferenceField>
        ))}
      </ReferenceFields>
      <ReferenceMarkdown text={row.body} empty="No row notes yet." />
    </ReferenceDocument>
  );
}

function AreaReference({ id, href }: { id: string; href: string }) {
  const { data: areas = [], isLoading } = useAreas();
  if (isLoading) return <ReferenceLoading />;
  const area = areas.find((candidate) => candidate.id === id);
  if (!area) return <ReferenceMissing label="Area not found." href={href} />;

  return (
    <ReferenceDocument href={href}>
      <ReferenceFields>
        <ReferenceField label="Color">{area.color}</ReferenceField>
      </ReferenceFields>
      <ReferenceMarkdown text={area.description ?? ""} empty="No area brief yet." />
    </ReferenceDocument>
  );
}

function MailReference({ id, href }: { id: string; href: string }) {
  const { data: email, isLoading } = useEmail(id);
  if (isLoading) return <ReferenceLoading />;
  if (!email) return <ReferenceMissing label="Email not found." href={href} />;

  return (
    <ReferenceDocument href={href}>
      <ReferenceFields>
        <ReferenceField label="From">
          {email.from} &lt;{email.fromEmail}&gt;
        </ReferenceField>
        <ReferenceField label="Date">{formatDateTime(email.date)}</ReferenceField>
        {email.labels.length > 0 && (
          <ReferenceField label="Labels">{email.labels.join(", ")}</ReferenceField>
        )}
      </ReferenceFields>
      <ReferenceMarkdown text={email.body} empty="No body." />
    </ReferenceDocument>
  );
}

function UnsupportedReference({ href }: { href: string }) {
  return (
    <ReferenceDocument href={href}>
      <p className="text-[13px] leading-6 text-muted-foreground">
        This page can be kept as a reference, but it does not have a compact
        sidebar renderer yet.
      </p>
    </ReferenceDocument>
  );
}

function ReferenceDocument({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 pb-5 pt-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">
          {href}
        </span>
        <Link
          to={href}
          data-reference-main-link=""
          className="shrink-0 text-[12px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Open
        </Link>
      </div>
      {children}
    </div>
  );
}

function ReferenceFields({ children }: { children: React.ReactNode }) {
  return <dl className="mb-5 space-y-2">{children}</dl>;
}

function ReferenceField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[74px_minmax(0,1fr)] gap-3 text-[12.5px] leading-5">
      <dt className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-foreground/85">{children}</dd>
    </div>
  );
}

function ReferenceLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {children}
    </h3>
  );
}

function ReferenceMarkdown({
  text,
  empty = "No notes yet.",
}: {
  text: string;
  empty?: string;
}) {
  if (!text.trim()) {
    return <p className="text-[13px] text-muted-foreground">{empty}</p>;
  }
  return (
    <Markdown
      text={text}
      className="text-[13.5px] leading-6 text-foreground/90 [&_a]:break-words [&_blockquote]:text-muted-foreground [&_code]:text-[12px] [&_li]:pl-0 [&_p]:my-3 [&_ul]:my-3"
    />
  );
}

function ReferenceLoading() {
  return (
    <div className="space-y-3 px-4 py-5">
      <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
    </div>
  );
}

function ReferenceMissing({ label, href }: { label: string; href: string }) {
  return (
    <ReferenceDocument href={href}>
      <p className="text-[13px] text-muted-foreground">{label}</p>
    </ReferenceDocument>
  );
}

function parseReferenceHref(href: string): ReferenceTarget {
  let url: URL;
  try {
    const base =
      typeof window === "undefined" ? "http://woodshed.local" : window.location.origin;
    url = new URL(href, base);
  } catch {
    return { kind: "unsupported", href };
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean).map(decodePathSegment);

  if (path === "/") return { kind: "daily", date: null };
  if (segments[0] === "notebook" && segments[1]) {
    return { kind: "note", id: segments[1] };
  }
  if (segments[0] === "resources" && segments[1]) {
    return { kind: "resource", id: segments[1] };
  }
  if (segments[0] === "people" && segments[1]) {
    return { kind: "person", id: segments[1] };
  }
  if (segments[0] === "areas" && segments[1]) {
    return { kind: "area", id: segments[1] };
  }
  if (segments[0] === "mail" && segments[1]) {
    return { kind: "mail", id: segments[1] };
  }
  if ((segments[0] === "databases" || segments[0] === "tables") && segments[1]) {
    if (segments[1] === "tags") return { kind: "unsupported", href };
    if (segments[1] === "custom") return { kind: "unsupported", href };
    if (segments[2]) {
      return { kind: "row", tableId: segments[1], rowId: segments[2] };
    }
    return { kind: "table", id: segments[1] };
  }
  if (segments[0] === "cadence") {
    if (segments[1] === "event" && segments[2] === "ical" && segments[3] && segments[4]) {
      return {
        kind: "ical-event",
        accountId: segments[3],
        externalId: segments[4],
        occurrenceDate: url.searchParams.get("date") ?? undefined,
      };
    }
    if (segments[1] === "event" && segments[2]) {
      return { kind: "event", id: segments[2] };
    }
    if (isIsoDate(segments[1]) && segments[2] === "task" && segments[3]) {
      return { kind: "task", id: segments[3] };
    }
    if (isIsoDate(segments[1])) {
      return { kind: "daily", date: segments[1] };
    }
  }

  return { kind: "unsupported", href };
}

function formatCellValue(value: CellValue | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined || value === "") return "Empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isIsoDate(value: string | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatDate(value: string): string {
  const parsed = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
