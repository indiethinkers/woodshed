import type { EventDto } from "@/lib/hooks/use-events";
import type { NoteDto } from "@/lib/hooks/use-notes";
import type { PersonDto } from "@/lib/hooks/use-people";
import type { ResourceDto } from "@/lib/hooks/use-resources";
import type { TagTableRow } from "@/lib/hooks/use-tag-table";
import type { TaskDto } from "@/lib/hooks/use-tasks";
import type { EmailSummary } from "@/lib/mail-lib/types";

export type PersonActivityKind = "mail" | "event" | "task" | "note" | "resource";

export interface PersonActivityItem {
  id: string;
  kind: PersonActivityKind;
  title: string;
  subtitle: string;
  date: string;
  href: string;
}

export interface BuildPersonActivityInput {
  person: PersonDto;
  notes: NoteDto[];
  tasks: TaskDto[];
  eventRows: TagTableRow[];
  emails: EmailSummary[];
  resources?: ResourceDto[];
  limit?: number;
  now?: Date | string;
}

export function buildPersonActivity({
  person,
  notes,
  tasks,
  eventRows,
  emails,
  resources = [],
  limit = 8,
  now = new Date(),
}: BuildPersonActivityInput): PersonActivityItem[] {
  const labels = personLabels(person);
  const items: PersonActivityItem[] = [];
  const nowMs = toTime(now);

  for (const email of emails) {
    if (!matchesEmail(email, person, labels)) continue;
    items.push({
      id: `mail:${email.id}`,
      kind: "mail",
      title: email.subject || "(no subject)",
      subtitle: [email.from, email.preview].filter(Boolean).join(" - "),
      date: email.date,
      href: `/mail/${encodeURIComponent(email.id)}`,
    });
  }

  for (const row of eventRows) {
    if (!matchesEvent(row.event, person, labels)) continue;
    const occurrenceDate = (row.event?.date ?? row.date).slice(0, 10);
    const href =
      row.event?.provider === "ical" && row.event.accountId && row.event.externalId
        ? `/cadence/event/ical/${encodeURIComponent(row.event.accountId)}/${encodeURIComponent(row.event.externalId)}?date=${occurrenceDate}`
        : `/cadence/event/${encodeURIComponent(row.id)}`;
    items.push({
      id: `event:${row.id}:${occurrenceDate}`,
      kind: "event",
      title: row.title || "(untitled event)",
      subtitle: [
        row.event?.duration ? `${row.event.duration} min` : "",
        row.path,
      ]
        .filter(Boolean)
        .join(" - "),
      date: row.event?.date ?? row.date,
      href,
    });
  }

  for (const task of tasks) {
    if (!containsPersonWikilink(`${task.content}\n${task.body}`, labels)) continue;
    items.push({
      id: `task:${task.id}`,
      kind: "task",
      title: task.content,
      subtitle: task.status.replace("-", " "),
      date: task.scheduled ?? task.created ?? "",
      // Unscheduled tasks have no cadence day of their own; open them in
      // today's cadence context (the editor loads by id regardless of date).
      href: `/cadence/${task.scheduled ?? localDay(now)}/task/${encodeURIComponent(task.id)}`,
    });
  }

  for (const note of notes) {
    if (!containsPersonWikilink(`${note.title}\n${note.body}`, labels)) continue;
    items.push({
      id: `note:${note.id}`,
      kind: "note",
      title: note.title || "(untitled note)",
      subtitle: preview(note.body) || note.path,
      date: note.created,
      href: `/notebook/${encodeURIComponent(note.id)}`,
    });
  }

  for (const resource of resources) {
    if (!matchesResource(resource, labels)) continue;
    items.push({
      id: `resource:${resource.id}`,
      kind: "resource",
      title: resource.title || "(untitled resource)",
      subtitle: resource.source || resource.url,
      date: resource.capturedAt ?? resource.saved,
      href: `/resources/${encodeURIComponent(resource.id)}`,
    });
  }

  items.sort((a, b) => compareActivityItems(a, b, nowMs));
  return items.slice(0, limit);
}

export function personLabels(person: PersonDto): string[] {
  return uniqueLower([
    person.id,
    person.name,
    slugify(person.name),
    person.email,
  ]);
}

function matchesEmail(
  email: EmailSummary,
  person: PersonDto,
  labels: string[],
): boolean {
  const targetEmail = person.email.trim().toLowerCase();
  if (targetEmail && email.fromEmail.trim().toLowerCase() === targetEmail) {
    return true;
  }
  const mentionSet = new Set(email.mentions.map((mention) => mention.toLowerCase()));
  return labels.some((label) => mentionSet.has(label));
}

function matchesEvent(
  event: EventDto | undefined,
  person: PersonDto,
  labels: string[],
): boolean {
  if (!event) return false;
  const targetEmail = person.email.trim().toLowerCase();
  for (const attendee of event.resolvedAttendees ?? []) {
    if (attendee.personId === person.id) return true;
    if (targetEmail && attendee.email?.toLowerCase() === targetEmail) return true;
    if (labels.includes(attendee.raw.toLowerCase())) return true;
  }
  return event.attendees.some((raw) => labels.includes(raw.toLowerCase()));
}

function matchesResource(resource: ResourceDto, labels: string[]): boolean {
  // Captured people are stored as linked person ids (or, for legacy
  // values, their names) — all land in `labels`. A plain wikilink mention
  // in the title/body also counts, mirroring notes and tasks.
  const people = resource.people.map((entry) => entry.trim().toLowerCase());
  if (people.some((entry) => labels.includes(entry))) return true;
  return containsPersonWikilink(`${resource.title}\n${resource.body}`, labels);
}

function containsPersonWikilink(markdown: string, labels: string[]): boolean {
  const labelSet = new Set(labels);
  for (const match of markdown.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const label = match[1].trim().toLowerCase();
    if (labelSet.has(label)) return true;
  }
  return false;
}

function compareActivityItems(
  a: PersonActivityItem,
  b: PersonActivityItem,
  nowMs: number,
): number {
  const aMs = toTime(a.date);
  const bMs = toTime(b.date);
  if (aMs === null && bMs === null) return a.title.localeCompare(b.title);
  if (aMs === null) return 1;
  if (bMs === null) return -1;

  const aFuture = aMs > nowMs;
  const bFuture = bMs > nowMs;
  if (aFuture !== bFuture) return aFuture ? 1 : -1;
  if (aFuture && bFuture) return aMs - bMs || a.title.localeCompare(b.title);
  return bMs - aMs || a.title.localeCompare(b.title);
}

function preview(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim()
    .split(/\n\s*\n/)[0]
    ?.replace(/\s+/g, " ")
    .slice(0, 120) ?? "";
}

function uniqueLower(values: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim().toLowerCase();
    if (normalized) out.add(normalized);
  }
  return [...out];
}

function toTime(value: Date | string): number;
function toTime(value: string): number | null;
function toTime(value: Date | string): number | null {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Local-time YYYY-MM-DD, used as the cadence-day context for unscheduled tasks. */
function localDay(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
