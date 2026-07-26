/**
 * Area identifiers are slugged strings. The five default areas are seeded
 * by the vault on first run; users can create more via areas_create. Any
 * code that needs to react to a finite set should call useAreas() at runtime
 * rather than match against a hardcoded union.
 */
export type AreaId = string;

export type AvatarColor =
  | "teal"
  | "purple"
  | "blue"
  | "coral"
  | "pink"
  | "amber"
  | "gray";

export interface Person {
  id: string;
  name: string;
  initials: string;
  avatar?: string;
  role: string;
  company: string;
  email: string;
  area: AreaId | null;
  description: string;
  stats: { emails: number; meetings: number; notes: number };
}

export type RecurringRule = "none" | "daily" | "weekly" | "monthly";

export interface CalendarEvent {
  id: string;
  path?: string;
  title: string;
  subtitle?: string;
  body?: string;
  date: string;
  duration: number;
  area: AreaId;
  attendees: string[];
  recurring?: RecurringRule | string;
}

export type TaskStatus = "backlog" | "in-progress" | "done";

export interface Task {
  id: string;
  path?: string;
  content: string;
  body?: string;
  status: TaskStatus;
  area: AreaId;
  created?: string;
  scheduled?: string;
  tags: string[];
}

export type DailyTask = Task;

export interface DailyNote {
  content: string;
  tags: string[];
}

export interface DailyPage {
  file: string;
  date: string;
  tasks: DailyTask[];
  notes: DailyNote[];
  woodshed: string;
}

export interface CustomTableRow {
  file: string;
  [key: string]: string | number | string[];
}

export interface CustomTable {
  name: string;
  folder: string;
  schema: string[];
  rows: CustomTableRow[];
}

export interface Clipping {
  id: string;
  title: string;
  url: string;
  source: string;
  saved: string;
  tags: string[];
  highlights: string[];
}

export interface TimelineEntry {
  type: "event" | "note";
  title: string;
  date: string;
  summary: string;
}

export interface NotebookEntry {
  id: string;
  title: string;
  area: AreaId | null;
  created: string;
  tags: string[];
  body: string;
}

export interface Area {
  id: AreaId;
  name: string;
  color: string;
  description?: string;
}
