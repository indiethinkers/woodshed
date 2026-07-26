import type { ElementType } from "react";
import { BookOpen, Calendar, CheckSquare, User } from "lucide-react";
import { UNASSIGNED_AREA_ID } from "@/lib/areas";
import type { NoteDto } from "@/lib/hooks/use-notes";
import type { PersonDto } from "@/lib/hooks/use-people";
import type { TaskDto } from "@/lib/hooks/use-tasks";
import type { TagTableRow } from "@/lib/hooks/use-tag-table";

// Shared model for the "everything in an area, newest first" feed. Used by
// the area detail view (one area) and the Areas index list panel (every
// area, as a cross-cutting activity stream). Keeping the mapping here means
// both render identical rows and route records the same way.

export type AreaItemType = "event" | "task" | "note" | "person";

export interface UnifiedItem {
  id: string;
  type: AreaItemType;
  title: string;
  subtitle: string;
  /** Source area id ("" when unassigned). Lets the cross-area feed label
   *  each row with its area; the single-area view ignores it. */
  area: string;
  date: string;
  href: string;
  filePath: string;
}

export const areaItemIcons: Record<AreaItemType, ElementType> = {
  event: Calendar,
  task: CheckSquare,
  note: BookOpen,
  person: User,
};

interface BuildOptions {
  events: TagTableRow[];
  tasks: TaskDto[];
  notes: NoteDto[];
  people: PersonDto[];
  /** Area id to filter by; `UNASSIGNED_AREA_ID` for the orphan bucket; or
   *  `null` to include every area (the cross-area activity feed). */
  area: string | null;
  /** Today's date (YYYY-MM-DD), used to route unscheduled tasks into a
   *  cadence day. */
  today: string;
}

export function buildAreaItems({
  events,
  tasks,
  notes,
  people,
  area,
  today,
}: BuildOptions): UnifiedItem[] {
  const isUnassigned = area === UNASSIGNED_AREA_ID;
  const next: UnifiedItem[] = [];

  for (const event of events) {
    if (!matchesArea(event.area, area, isUnassigned)) continue;
    next.push(itemFromEventRow(event));
  }
  for (const task of tasks) {
    if (!matchesArea(task.area, area, isUnassigned)) continue;
    next.push(itemFromTask(task, today));
  }
  for (const note of notes) {
    if (!matchesArea(note.area, area, isUnassigned)) continue;
    next.push({
      id: note.id,
      type: "note",
      title: note.title,
      subtitle: previewMarkdown(note.body),
      area: note.area ?? "",
      date: note.created,
      href: `/notebook/${note.id}`,
      filePath: note.path,
    });
  }
  for (const person of people) {
    if (!matchesArea(person.area, area, isUnassigned)) continue;
    next.push({
      id: person.id,
      type: "person",
      title: person.name,
      subtitle: [person.role, person.company].filter(Boolean).join(" · "),
      area: person.area ?? "",
      date: "",
      href: `/people/${person.id}`,
      filePath: person.path,
    });
  }

  next.sort(compareAreaItems);
  return next;
}

function matchesArea(
  value: string | null | undefined,
  area: string | null,
  isUnassigned: boolean,
) {
  if (area === null) return true; // every area (cross-area feed)
  return isUnassigned
    ? value == null || value === "" || value === UNASSIGNED_AREA_ID
    : value === area;
}

function itemFromEventRow(row: TagTableRow): UnifiedItem {
  const event = row.event;
  const occurrenceDate = (event?.date ?? row.date).slice(0, 10);
  const href =
    event?.provider === "ical" && event.accountId && event.externalId
      ? `/cadence/event/ical/${encodeURIComponent(event.accountId)}/${encodeURIComponent(event.externalId)}?date=${occurrenceDate}`
      : `/cadence/event/${row.id}`;
  return {
    id: row.id,
    type: "event",
    title: row.title,
    subtitle: [event?.duration ? `${event.duration} min` : "", row.path]
      .filter(Boolean)
      .join(" · "),
    area: row.area,
    date: row.date,
    href,
    filePath: row.path,
  };
}

function itemFromTask(task: TaskDto, today: string): UnifiedItem {
  // Unscheduled tasks have no cadence day of their own; open them in today's
  // cadence context (the editor loads by id regardless of the date segment).
  const href = `/cadence/${task.scheduled ?? today}/task/${task.id}`;
  return {
    id: task.id,
    type: "task",
    title: task.content,
    subtitle: [
      task.status.replace("-", " "),
      task.scheduled ? `scheduled ${task.scheduled}` : "unscheduled",
    ].join(" · "),
    area: task.area ?? "",
    date: task.scheduled ?? task.created ?? "",
    href,
    filePath: task.path,
  };
}

function compareAreaItems(a: UnifiedItem, b: UnifiedItem) {
  if (!a.date && !b.date) return a.title.localeCompare(b.title);
  if (!a.date) return 1;
  if (!b.date) return -1;
  return b.date.localeCompare(a.date);
}

export function previewMarkdown(markdown: string) {
  return (
    markdown
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
      .slice(0, 140) ?? ""
  );
}

export function formatAreaItemDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
