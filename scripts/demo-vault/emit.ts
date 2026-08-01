// Typed record → markdown writers.
//
// Each writer mirrors one frontmatter struct in `src-tauri/src/parsers/` (or,
// for mail/agent, the hand-rolled renderers in their own modules). Where
// the Rust side declares `skip_serializing_if`, the corresponding field here is
// `undefined` when empty so the key is omitted entirely. Writing
// `favorite: false` or `role: ""` would be re-serialized away by the app on
// first edit and produce spurious diffs.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { frontmatterDoc, quote, scalar, toYaml, type YamlValue } from "./yaml";

export type TaskStatus = "backlog" | "in-progress" | "done";
export type RecurringRule = "none" | "daily" | "weekly" | "monthly";

/** Collapse an empty string to `undefined` so the key is skipped. */
function omitEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** Collapse `false` to `undefined` (for `skip_serializing_if = "is_false"`). */
function omitFalse(value: boolean | undefined): true | undefined {
  return value ? true : undefined;
}

/** Collapse an empty array to `undefined` (`skip_serializing_if = "Vec::is_empty"`). */
function omitEmptyList<T>(value: readonly T[] | undefined): T[] | undefined {
  return value === undefined || value.length === 0 ? undefined : [...value];
}

/**
 * Writes files and keeps a per-directory tally so the CLI can report what it
 * produced. Every path is resolved under the vault root.
 */
export class VaultWriter {
  readonly root: string;
  private readonly counts = new Map<string, number>();

  constructor(root: string) {
    this.root = root;
  }

  write(relPath: string, contents: string): void {
    if (contents.includes("\u2014")) {
      throw new Error(`demo content must not contain an em dash: ${relPath}`);
    }
    const abs = join(this.root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
    const bucket = relPath.split("/")[0];
    this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + 1);
  }

  /** Directory → file count, alphabetical. */
  tally(): Array<[string, number]> {
    return [...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
    return sum;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Area: parsers/mod.rs:569
// ─────────────────────────────────────────────────────────────────────────────

export interface AreaInput {
  id: string;
  name: string;
  color?: string;
  created?: string;
  body?: string;
}

export function writeArea(w: VaultWriter, area: AreaInput): void {
  w.write(
    `areas/${area.id}.md`,
    frontmatterDoc(
      {
        type: "area",
        id: area.id,
        name: area.name,
        color: omitEmpty(area.color),
        created: area.created,
      },
      area.body,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Person: parsers/mod.rs:484
// ─────────────────────────────────────────────────────────────────────────────

export interface PersonInput {
  id: string;
  name: string;
  initials?: string;
  role?: string;
  company?: string;
  email?: string;
  relationship?: string;
  area?: string;
  created?: string;
  favorite?: boolean;
  body?: string;
}

export function writePerson(w: VaultWriter, person: PersonInput): void {
  w.write(
    `people/${person.id}.md`,
    frontmatterDoc(
      {
        type: "person",
        id: person.id,
        name: person.name,
        initials: omitEmpty(person.initials),
        role: omitEmpty(person.role),
        company: omitEmpty(person.company),
        email: omitEmpty(person.email),
        relationship: omitEmpty(person.relationship),
        area: person.area,
        created: person.created,
        favorite: omitFalse(person.favorite),
      },
      person.body,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Note: parsers/mod.rs:525
// ─────────────────────────────────────────────────────────────────────────────

export interface NoteInput {
  id: string;
  title: string;
  area?: string;
  created: string;
  tags?: string[];
  favorite?: boolean;
  body: string;
}

export function writeNote(w: VaultWriter, note: NoteInput): void {
  w.write(
    `notebook/${note.id}.md`,
    frontmatterDoc(
      {
        type: "note",
        id: note.id,
        title: note.title,
        area: note.area,
        created: note.created,
        // `tags` carries no skip_serializing_if, so it is always emitted.
        tags: note.tags ?? [],
        favorite: omitFalse(note.favorite),
      },
      note.body,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource: parsers/mod.rs:540
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Note the absence of `area`. Resources deliberately do not belong to one area.
 * `serialize_resource` hardcodes `area: None` (parsers/mod.rs:974), so a
 * generated `area:` key would silently vanish the first time the app saved the
 * record. Leaving it off the input type makes that unrepresentable.
 */
export interface ResourceInput {
  id: string;
  title: string;
  url: string;
  source: string;
  saved: string;
  author?: string;
  published?: string;
  tags?: string[];
  highlights?: string[];
  favorite?: boolean;
  body?: string;
}

export function writeResource(w: VaultWriter, resource: ResourceInput): void {
  w.write(
    `resources/${resource.id}.md`,
    frontmatterDoc(
      {
        type: "resource",
        id: resource.id,
        title: resource.title,
        url: resource.url,
        source: resource.source,
        saved: resource.saved,
        author: resource.author,
        published: resource.published,
        tags: resource.tags ?? [],
        highlights: resource.highlights ?? [],
        favorite: omitFalse(resource.favorite),
      },
      resource.body,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Task: parsers/mod.rs:376
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskInput {
  id: string;
  content: string;
  status: TaskStatus;
  area: string;
  created?: string;
  scheduled?: string;
  tags?: string[];
  timeSpentSeconds?: number;
  inProgressStartedAt?: string;
  sortKey?: number;
  body?: string;
}

export function writeTask(w: VaultWriter, task: TaskInput): void {
  w.write(
    `tasks/${task.id}.md`,
    frontmatterDoc(
      {
        type: "task",
        id: task.id,
        content: task.content,
        status: task.status,
        area: task.area,
        created: task.created,
        scheduled: task.scheduled,
        tags: task.tags ?? ["task"],
        time_spent_seconds: task.timeSpentSeconds,
        in_progress_started_at: task.inProgressStartedAt,
        sort_key: task.sortKey,
      },
      task.body,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Event: parsers/mod.rs:399
// ─────────────────────────────────────────────────────────────────────────────

export interface EventInput {
  id: string;
  title: string;
  subtitle?: string;
  date: string;
  duration: number;
  area: string;
  attendees?: string[];
  recurring?: RecurringRule;
  tags?: string[];
  body?: string;
}

export function writeEvent(w: VaultWriter, event: EventInput): void {
  w.write(
    `events/${event.id}.md`,
    frontmatterDoc(
      {
        type: "event",
        id: event.id,
        title: event.title,
        subtitle: event.subtitle,
        date: event.date,
        duration: event.duration,
        area: event.area,
        // `attendees` has no skip_serializing_if, so it is always emitted.
        attendees: event.attendees ?? [],
        recurring: event.recurring ?? "none",
        tags: omitEmptyList(event.tags),
      },
      event.body,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily journal: parsers/mod.rs:446
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyInput {
  date: string;
  body?: string;
}

/**
 * Journals carry the day's written content only. Events live one-per-file in
 * `events/` (the inline `events:` array is the legacy shape, kept parsing for
 * older vaults), so nothing here writes it.
 */
export function writeDaily(w: VaultWriter, daily: DailyInput): void {
  w.write(
    `cadence/${daily.date}.md`,
    frontmatterDoc({ type: "daily", date: daily.date }, daily.body),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tables: parsers/mod.rs:581 (schema) and :657 (rows)
// ─────────────────────────────────────────────────────────────────────────────

export type ColumnType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "checkbox"
  | "date";

export type NumberFormat =
  | "number"
  | "us_dollar"
  | "euro"
  | "british_pound"
  | "japanese_yen"
  | "percent";

export type CalcFn = "sum" | "count" | "avg" | "min" | "max";

export interface SelectOptionInput {
  id: string;
  name: string;
  color: string;
}

export interface ColumnInput {
  id: string;
  name: string;
  type: ColumnType;
  options?: SelectOptionInput[];
  width?: number;
  format?: NumberFormat;
  precision?: number;
}

export interface ViewInput {
  id: string;
  name: string;
  type: "table" | "board";
  sorts?: Array<{ column: string; direction: "asc" | "desc" }>;
  filters?: {
    op?: "and" | "or";
    conditions: Array<{ column: string; op: string; value?: YamlValue }>;
  };
  hidden?: string[];
  calculations?: Record<string, CalcFn>;
  groupBy?: string;
}

export interface TableInput {
  id: string;
  name: string;
  created: string;
  favorite?: boolean;
  columns: ColumnInput[];
  views: ViewInput[];
}

function columnToYaml(column: ColumnInput): YamlValue {
  return {
    id: column.id,
    name: column.name,
    type: column.type,
    options: omitEmptyList(column.options)?.map((option) => ({
      id: option.id,
      name: option.name,
      color: option.color,
    })),
    width: column.width,
    format: column.format,
    precision: column.precision,
  };
}

function viewToYaml(view: ViewInput): YamlValue {
  const conditions = view.filters?.conditions ?? [];
  return {
    id: view.id,
    name: view.name,
    type: view.type,
    sorts: omitEmptyList(view.sorts)?.map((sort) => ({
      column: sort.column,
      direction: sort.direction,
    })),
    // ViewFilters is skipped only when it has no conditions.
    filters:
      conditions.length === 0
        ? undefined
        : {
            op: view.filters?.op ?? "and",
            conditions: conditions.map((condition) => ({
              column: condition.column,
              op: condition.op,
              value: condition.value,
            })),
          },
    hidden: omitEmptyList(view.hidden),
    calculations:
      view.calculations && Object.keys(view.calculations).length > 0
        ? (view.calculations as Record<string, YamlValue>)
        : undefined,
    group_by: view.groupBy,
  };
}

export function writeTable(w: VaultWriter, table: TableInput): void {
  // Table schemas have no body. `serialize_table_schema` emits frontmatter
  // only (parsers/mod.rs:1051).
  w.write(
    `tables/${table.id}/_schema.md`,
    frontmatterDoc({
      type: "table",
      id: table.id,
      name: table.name,
      created: table.created,
      favorite: omitFalse(table.favorite),
      columns: omitEmptyList(table.columns)?.map(columnToYaml),
      views: omitEmptyList(table.views)?.map(viewToYaml),
    }),
  );
}

export interface RowInput {
  id: string;
  table: string;
  created: string;
  cells: Record<string, YamlValue>;
  body?: string;
}

export function writeRow(w: VaultWriter, row: RowInput): void {
  w.write(
    `tables/${row.table}/${row.id}.md`,
    frontmatterDoc(
      {
        type: "row",
        id: row.id,
        table: row.table,
        created: row.created,
        cells:
          Object.keys(row.cells).length > 0
            ? (row.cells as Record<string, YamlValue>)
            : undefined,
      },
      row.body,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mail: commands/mail.rs:1410 (email) and :1477 (draft)
// ─────────────────────────────────────────────────────────────────────────────

export type MailFolder = "inbox" | "sent" | "archive";

export interface EmailInput {
  id: string;
  threadId: string;
  inbox: string;
  from: string;
  fromEmail: string;
  subject: string;
  date: string;
  read: boolean;
  labels?: string[];
  mentions?: string[];
  links?: string[];
  body: string;
  /** Filename stem; defaults to `id`. Real syncs use a shortened slug. */
  slug?: string;
}

function commaJoin(values: readonly string[] | undefined): string {
  return (values ?? []).map((value) => scalar(value)).join(", ");
}

/**
 * `render_email_md` hand-formats this YAML rather than going through serde,
 * and JSON-quotes the machine identifiers (id, thread, inbox, from_email)
 * because message-ids contain `=`, `@`, `+` and `/`. Mirrored here.
 */
export function writeEmail(
  w: VaultWriter,
  folder: MailFolder,
  email: EmailInput,
): void {
  const preview = email.body.replace(/\s+/g, " ").trim().slice(0, 200);
  const contents =
    "---\n" +
    `type: email\n` +
    `id: ${quote(email.id)}\n` +
    `thread: ${quote(email.threadId)}\n` +
    `inbox: ${quote(email.inbox)}\n` +
    `from: ${scalar(email.from)}\n` +
    `from_email: ${quote(email.fromEmail)}\n` +
    `subject: ${scalar(email.subject)}\n` +
    `preview: ${scalar(preview)}\n` +
    `date: ${email.date}\n` +
    `read: ${email.read}\n` +
    `labels: [${commaJoin(email.labels)}]\n` +
    `mentions: [${commaJoin(email.mentions)}]\n` +
    `links: [${commaJoin(email.links)}]\n` +
    "---\n\n" +
    `${email.body}\n`;
  w.write(`${folder}/${email.slug ?? email.id}.md`, contents);
}

export interface DraftInput {
  id: string;
  created: string;
  kind: "new" | "reply";
  fromInbox: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  sourceMessageId?: string;
  threadId?: string;
  body: string;
}

export function writeDraft(w: VaultWriter, draft: DraftInput): void {
  const contents =
    "---\n" +
    `type: draft\n` +
    `id: ${draft.id}\n` +
    `kind: ${draft.kind}\n` +
    `created: ${draft.created}\n` +
    `from_inbox: ${draft.fromInbox}\n` +
    `to: [${commaJoin(draft.to)}]\n` +
    `cc: [${commaJoin(draft.cc)}]\n` +
    `bcc: [${commaJoin(draft.bcc)}]\n` +
    `subject: ${scalar(draft.subject)}\n` +
    `source_message_id: ${draft.sourceMessageId ?? ""}\n` +
    `thread_id: ${draft.threadId ?? ""}\n` +
    "---\n\n" +
    `${draft.body}\n`;
  w.write(`drafts/${draft.id}.md`, contents);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent transcripts: agent/mod.rs:365 (frontmatter) and :1294 (message blocks)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentMessageInput {
  id: string;
  role: "system" | "user" | "assistant";
  created: string;
  content: string;
}

export interface AgentChatInput {
  id: string;
  title: string;
  agent: string;
  model: string;
  created: string;
  updated: string;
  pinned?: boolean;
  tags?: string[];
  context?: { title: string; route: string };
  messages: AgentMessageInput[];
}

export function writeAgentChat(w: VaultWriter, chat: AgentChatInput): void {
  const blocks = chat.messages
    .map((message) => {
      const meta = [
        `id: ${scalar(message.id)}`,
        `role: ${message.role}`,
        `created: ${scalar(message.created)}`,
      ].join("\n");
      const content = message.content.replace(/^\n+/, "").replace(/\n+$/, "");
      return `<!-- woodshed-agent-message\n${meta}\n-->\n\n${content}\n\n<!-- /woodshed-agent-message -->`;
    })
    .join("\n\n");

  w.write(
    `agent/${chat.id}.md`,
    frontmatterDoc(
      {
        type: "agent_chat",
        id: chat.id,
        title: chat.title,
        agent: chat.agent,
        model: chat.model,
        created: chat.created,
        updated: chat.updated,
        pinned: omitFalse(chat.pinned),
        tags: omitEmptyList(chat.tags),
        context: chat.context
          ? { title: chat.context.title, route: chat.context.route }
          : undefined,
      },
      blocks,
    ),
  );
}
