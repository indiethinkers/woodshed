// Command palette search backend. Three sources:
//   1. Static nav pages (Cadence, Notebook, …) — substring-matched in
//      the browser. Always present; never goes through Tauri.
//   2. Date keywords (today / yesterday / tomorrow) — recomputed every search
//      so the routes always point at the *current* day.
//   3. Vault search — handled by the Rust FTS5 index via the `useSearch`
//      hook. Lives outside this file because it's an async query; this file
//      is the synchronous half (groups + ordering).

import {
  Calendar,
  CalendarDays,
  Bot,
  CheckSquare,
  Database,
  FileText,
  Layers,
  Library,
  Mail,
  NotebookPen,
  Users,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

export type CommandKind =
  | "action"
  | "page"
  | "day"
  | "person"
  | "note"
  | "event"
  | "task"
  | "resource"
  | "daily"
  | "area"
  | "mail"
  | "table"
  | "row"
  | "agent_chat";

export type CommandAction =
  | { type: "create-note"; title: string }
  | { type: "create-task"; content: string }
  | { type: "create-person"; name: string }
  | { type: "create-resource"; title: string; url: string; source: string }
  | { type: "create-area"; name: string }
  | { type: "create-table"; name: string };

export interface CommandItem {
  id: string;
  kind: CommandKind;
  label: string;
  hint?: string;
  href: string;
  icon: LucideIcon;
  action?: CommandAction;
  /** Lower-case haystack used by the in-browser substring scorer. Only
   *  consulted for nav pages and date keywords; backend hits are pre-ranked
   *  by FTS5 and skip the scorer. */
  keywords: string;
}

const KIND_LABEL: Record<CommandKind, string> = {
  action: "Create",
  page: "Pages",
  day: "Days",
  person: "People",
  note: "Notes",
  event: "Events",
  task: "Tasks",
  resource: "Resources",
  daily: "Daily pages",
  area: "Areas",
  mail: "Mail",
  table: "Databases",
  row: "Rows",
  agent_chat: "Agent chats",
};

// Navigational groups are pinned to the top in this fixed order — date
// keywords, nav pages, and create-actions are exact affordances that
// should always lead. Everything below them (the vault-content kinds:
// person, note, event, task, resource, daily, area) is ordered
// dynamically by FTS5 rank — see `compileResults` — so the kind that owns
// the strongest hit leads. Typing an area name therefore surfaces the
// Areas group first; typing a person's name surfaces People first.
const NAV_ORDER: CommandKind[] = ["day", "page", "action"];

const ICON_BY_KIND: Record<string, LucideIcon> = {
  task: CheckSquare,
  event: CalendarDays,
  daily: Calendar,
  note: FileText,
  person: Users,
  resource: Library,
  area: Layers,
  mail: Mail,
  table: Database,
  row: Database,
  agent_chat: Bot,
};

export const navPages: CommandItem[] = [
  { id: "page-cadence", kind: "page", label: "Cadence", href: "/", icon: Calendar, keywords: "cadence calendar today daily" },
  { id: "page-mail", kind: "page", label: "Mail", href: "/mail", icon: Mail, keywords: "mail inbox email gmail" },
  { id: "page-agent", kind: "page", label: "Agent", href: "/agent", icon: Bot, keywords: "agent ai hermes assistant chat" },
  { id: "page-notebook", kind: "page", label: "Notebook", href: "/notebook", icon: NotebookPen, keywords: "notebook notes writing" },
  { id: "page-resources", kind: "page", label: "Resources", href: "/resources", icon: Library, keywords: "resources resources library clippings saved" },
  { id: "page-people", kind: "page", label: "People", href: "/people", icon: Users, keywords: "people contacts crm" },
  { id: "page-databases", kind: "page", label: "Databases", href: "/databases", icon: Database, keywords: "databases tables data structured rows tags hashtags generated" },
  { id: "page-areas", kind: "page", label: "Areas", href: "/areas", icon: Layers, keywords: "areas workspaces" },
  { id: "page-graph", kind: "page", label: "Graph", href: "/graph", icon: Waypoints, keywords: "graph links wikilinks network vault visualize" },
];

export interface CommandGroup {
  kind: CommandKind;
  label: string;
  items: CommandItem[];
}

export interface CompileInputs {
  /** Raw user query; empty string is allowed. */
  query: string;
  /** Today's date (YYYY-MM-DD) in local time. Caller passes from `useToday()`
   *  so the keywords always resolve to the *current* day. */
  today: string;
  /** Async results from the Rust FTS5 index, already ranked. */
  hits: { kind: string; docId: string; title: string; hint?: string; href: string }[];
  /** Cap on per-group rows to keep the palette scannable. */
  limit?: number;
}

/// Compose the final grouped result from the three sources.
export function compileResults({ query, today, hits, limit = 30 }: CompileInputs): CommandGroup[] {
  const q = query.trim().toLowerCase();

  if (!q) {
    // Empty query: just show nav pages. Anything more would dump the whole
    // vault and bury the navigational affordances.
    return [{ kind: "page", label: KIND_LABEL.page, items: navPages }];
  }

  const matchedPages: { item: CommandItem; score: number }[] = [];
  for (const page of navPages) {
    const score = scoreLocalMatch(page.label.toLowerCase(), page.keywords, q);
    if (score > 0) matchedPages.push({ item: page, score });
  }
  matchedPages.sort((a, b) => b.score - a.score);

  const dateItems = resolveDateKeywords(q, today);
  const actionItems = resolveActionItems(query);

  const hitItems: CommandItem[] = hits.slice(0, limit).map((h) => ({
    id: `${h.kind}-${h.docId}`,
    kind: normalizeHitKind(h.kind),
    label: h.title || "(untitled)",
    hint: h.hint,
    href: h.href,
    icon: ICON_BY_KIND[h.kind] ?? FileText,
    keywords: "",
  }));

  // Bucket by kind, preserving the order each source produced.
  const buckets = new Map<CommandKind, CommandItem[]>();
  const drop = (item: CommandItem) => {
    const list = buckets.get(item.kind);
    if (list) list.push(item);
    else buckets.set(item.kind, [item]);
  };
  for (const m of matchedPages) drop(m.item);
  for (const item of dateItems) drop(item);
  for (const item of actionItems) drop(item);
  for (const item of hitItems) drop(item);

  const groups: CommandGroup[] = [];

  // 1. Pinned navigational groups, in their fixed order, original item order.
  for (const kind of NAV_ORDER) {
    const list = buckets.get(kind);
    if (list && list.length) {
      groups.push({ kind, label: KIND_LABEL[kind], items: list });
    }
  }

  // 2. Vault-content groups, ordered by hit strength. Each hit scores by
  //    how strongly its title matches the query (exact → prefix →
  //    word-prefix → fuzzy; see `titleMatchTier`), then by FTS5 rank within
  //    a tier. A title match sits in a band strictly above fuzzy/body-only
  //    hits, so typing an area's name — or any prefix of it, like "crossb"
  //    — leads with the Areas group even when FTS5 scored a fuzzier
  //    person/note higher. Within a group the strongest match floats to the
  //    first row. A kind's rank is its strongest hit's score.
  //
  //    Daily pages are an exception inside a shared title-match tier: FTS5
  //    order is body-driven and ignores the calendar, so we re-rank by
  //    proximity to `today` (nearest upcoming first, then most recent past).
  const scoreOf = (item: CommandItem, idx: number) =>
    titleMatchTier(item.label, q) * hitItems.length + idx;

  const kindRank = new Map<CommandKind, number>();
  hitItems.forEach((item, idx) => {
    const score = scoreOf(item, idx);
    const prev = kindRank.get(item.kind);
    if (prev === undefined || score < prev) kindRank.set(item.kind, score);
  });

  const orderedKinds = [...kindRank.keys()].sort(
    (a, b) => kindRank.get(a)! - kindRank.get(b)!,
  );
  for (const kind of orderedKinds) {
    const list = buckets.get(kind);
    if (!list || !list.length) continue;
    const items = list
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => {
        const tierA = titleMatchTier(a.item.label, q);
        const tierB = titleMatchTier(b.item.label, q);
        if (tierA !== tierB) return tierA - tierB;
        if (kind === "daily") {
          const byDate = compareDailyByProximity(a.item, b.item, today);
          if (byDate !== 0) return byDate;
        }
        return a.idx - b.idx;
      })
      .map((x) => x.item);
    groups.push({ kind, label: KIND_LABEL[kind], items });
  }

  return groups;
}

/// Tier a vault hit by how strongly its title matches the query. Lower is
/// stronger: 0 exact, 1 title-prefix, 2 word-prefix, 3 fuzzy/body-only.
/// Used to lift directly-named records above hits FTS5 ranked higher on
/// body text. `q` is already lower-cased and trimmed.
function titleMatchTier(label: string, q: string): number {
  const t = label.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  for (const w of t.split(/\s+/)) {
    if (w.startsWith(q)) return 2;
  }
  return 3;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/// Resolve the calendar day for a daily-page hit. The indexer stores the
/// ISO date as both `docId` and `hint`; fall back to the cadence href.
function dailyDateOf(item: CommandItem): string | null {
  if (item.hint && ISO_DATE_RE.test(item.hint)) return item.hint;
  const fromHref = item.href.match(/\/cadence\/(\d{4}-\d{2}-\d{2})$/);
  return fromHref?.[1] ?? null;
}

/// Sort daily pages by proximity to `today`: upcoming dates ascending
/// (nearest future first, including today), then past dates descending
/// (most recent past next). ISO YYYY-MM-DD strings compare lexicographically.
export function compareDailyByProximity(
  a: CommandItem,
  b: CommandItem,
  today: string,
): number {
  const da = dailyDateOf(a);
  const db = dailyDateOf(b);
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;

  const aUpcoming = da >= today;
  const bUpcoming = db >= today;
  if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
  return aUpcoming ? da.localeCompare(db) : db.localeCompare(da);
}

// --- Creation actions ----------------------------------------------------

type ActionPrefix = {
  type: CommandAction["type"];
  pattern: RegExp;
};

const ACTION_PREFIXES: ActionPrefix[] = [
  { type: "create-note", pattern: /^(?:new\s+|create\s+)?note\s+(.+)$/i },
  { type: "create-task", pattern: /^(?:new\s+|create\s+)?task\s+(.+)$/i },
  {
    type: "create-person",
    pattern: /^(?:new\s+|create\s+)?(?:person|contact)\s+(.+)$/i,
  },
  { type: "create-area", pattern: /^(?:new\s+|create\s+)?area\s+(.+)$/i },
  {
    type: "create-table",
    pattern: /^(?:new\s+|create\s+)?(?:table|database)\s+(.+)$/i,
  },
  {
    type: "create-resource",
    pattern: /^(?:save|clip|capture|resource)\s+(.+)$/i,
  },
];

export function resolveActionItems(rawQuery: string): CommandItem[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const explicit = actionFromPrefixedQuery(query);
  if (explicit) return [commandItemFromAction(explicit)];

  const url = extractUrl(query);
  if (url) {
    return [commandItemFromAction(resourceAction(url))];
  }

  return [];
}

function actionFromPrefixedQuery(query: string): CommandAction | null {
  for (const prefix of ACTION_PREFIXES) {
    const match = query.match(prefix.pattern);
    const value = match?.[1]?.trim();
    if (!value) continue;
    if (prefix.type === "create-resource") {
      const url = extractUrl(value);
      if (!url) continue;
      return resourceAction(url);
    }
    return actionFromText(prefix.type, value);
  }
  return null;
}

function actionFromText(type: CommandAction["type"], text: string): CommandAction {
  switch (type) {
    case "create-note":
      return { type, title: text };
    case "create-task":
      return { type, content: text };
    case "create-person":
      return { type, name: text };
    case "create-area":
      return { type, name: text };
    case "create-table":
      return { type, name: text };
    case "create-resource": {
      const url = extractUrl(text) ?? text;
      return resourceAction(url);
    }
  }
}

function commandItemFromAction(action: CommandAction): CommandItem {
  switch (action.type) {
    case "create-note":
      return {
        id: `action-note-${action.title}`,
        kind: "action",
        label: `Create note “${action.title}”`,
        hint: "Notebook",
        href: "",
        icon: FileText,
        action,
        keywords: "",
      };
    case "create-task":
      return {
        id: `action-task-${action.content}`,
        kind: "action",
        label: `Create task “${action.content}”`,
        hint: "Cadence today",
        href: "",
        icon: CheckSquare,
        action,
        keywords: "",
      };
    case "create-person":
      return {
        id: `action-person-${action.name}`,
        kind: "action",
        label: `Create person “${action.name}”`,
        hint: "People",
        href: "",
        icon: Users,
        action,
        keywords: "",
      };
    case "create-resource":
      return {
        id: `action-resource-${action.url}`,
        kind: "action",
        label: `Save resource “${action.title}”`,
        hint: action.source,
        href: "",
        icon: Library,
        action,
        keywords: "",
      };
    case "create-area":
      return {
        id: `action-area-${action.name}`,
        kind: "action",
        label: `Create area “${action.name}”`,
        hint: "Areas",
        href: "",
        icon: Layers,
        action,
        keywords: "",
      };
    case "create-table":
      return {
        id: `action-table-${action.name}`,
        kind: "action",
        label: `Create database “${action.name}”`,
        hint: "Databases",
        href: "",
        icon: Database,
        action,
        keywords: "",
      };
  }
}

function resourceAction(rawUrl: string): CommandAction {
  const normalized = normalizeUrl(rawUrl);
  const source = sourceFromUrl(normalized);
  return {
    type: "create-resource",
    title: source || normalized,
    url: normalized,
    source,
  };
}

function extractUrl(input: string): string | null {
  const match = input.match(/\bhttps?:\/\/[^\s<>"']+/i);
  return match?.[0] ?? null;
}

function normalizeUrl(url: string): string {
  return url.replace(/[),.;:!?]+$/, "");
}

function sourceFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// --- Date keyword resolution ---------------------------------------------

const DATE_KEYWORDS: { word: string; offset: number }[] = [
  { word: "today", offset: 0 },
  { word: "tomorrow", offset: 1 },
  { word: "yesterday", offset: -1 },
];

/// Match the user's query against today/yesterday/tomorrow (prefix match,
/// so "tom" hits "tomorrow"). The resulting items always point at the
/// cadence route for the *current* day's offset, computed fresh each call.
export function resolveDateKeywords(q: string, today: string): CommandItem[] {
  const out: CommandItem[] = [];
  for (const { word, offset } of DATE_KEYWORDS) {
    if (!word.startsWith(q)) continue;
    const date = addDays(today, offset);
    out.push({
      id: `day-${word}`,
      kind: "day",
      label: capitalize(word),
      hint: formatDayHint(date),
      href: `/cadence/${date}`,
      icon: Calendar,
      keywords: `${word} ${date}`,
    });
  }
  return out;
}

/// Add `n` days to a YYYY-MM-DD date string, returning YYYY-MM-DD. Uses
/// local-time math (matches the format `useToday()` produces) so DST
/// transitions land on the right cadence day.
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function formatDayHint(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- Local scoring (nav pages only) -------------------------------------

function scoreLocalMatch(label: string, keywords: string, q: string): number {
  if (label === q) return 1000;
  if (label.startsWith(q)) return 500 - label.length;
  for (const w of label.split(/\s+/)) {
    if (w.startsWith(q)) return 300 - label.length;
  }
  if (label.includes(q)) return 150 - label.length;
  if (keywords.toLowerCase().includes(q)) return 50;
  return 0;
}

function normalizeHitKind(kind: string): CommandKind {
  switch (kind) {
    case "task":
      return "task";
    case "event":
      return "event";
    case "daily":
      return "daily";
    case "note":
      return "note";
    case "person":
      return "person";
    case "resource":
      return "resource";
    case "area":
      return "area";
    case "mail":
      return "mail";
    case "table":
      return "table";
    case "row":
      return "row";
    case "agent_chat":
      return "agent_chat";
    default:
      return "note";
  }
}
