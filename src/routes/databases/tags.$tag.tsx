import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarDays,
  CheckSquare,
  CircleDot,
  Clock3,
  Database,
  FileText,
  FolderKanban,
  Link2,
  Mail,
  Newspaper,
  Table2,
  User,
} from "lucide-react";
import { useCallback, useMemo, useState, type ElementType } from "react";
import { ContentPanel } from "@/components/layout/content-panel";
import {
  RecordLinkCell,
  RecordTable,
  selectOptionsFromValues,
  useRecordTableState,
  type RecordColumn,
} from "@/components/tables/record-table";
import { useTagTable, type TagTableRow } from "@/lib/hooks/use-tag-table";
import { useToday } from "@/lib/hooks/use-today";
import { tauriInvoke } from "@/lib/tauri";
import type { SelectOption, ViewSort } from "@/lib/hooks/use-tables";

// Generated tag tables are a kind of database, so they live under the
// /databases layout — the Databases sidebar stays put while browsing them.
// (Moved from the top-level /tags/$tag in June 2026; tags.tsx redirects
// old links.)
export const Route = createFileRoute("/databases/tags/$tag")({
  component: TagTablePage,
});

type TimeView = "upcoming" | "past" | "all" | "undated";

const typeIcons: Record<string, ElementType> = {
  area: FolderKanban,
  event: CalendarDays,
  note: FileText,
  mail: Mail,
  person: User,
  resource: Newspaper,
  row: Table2,
  task: CheckSquare,
};

const EVENT_SORTS: ViewSort[] = [{ column: "date", direction: "asc" }];
const GENERATED_SORTS: ViewSort[] = [{ column: "date", direction: "desc" }];

function TagTablePage() {
  const { tag: rawTag } = Route.useParams();
  const tag = cleanTag(rawTag);
  // Key the body by tag so the view state (search / filters / sort / time
  // window / selection) resets cleanly when navigating between tag tables.
  return (
    <ContentPanel wide filePath={`tag: #${tag}`}>
      <TagTable key={tag} tag={tag} />
    </ContentPanel>
  );
}

function TagTable({ tag }: { tag: string }) {
  const isEventTable = tag.toLowerCase() === "event";
  const { data: rows = [], isLoading } = useTagTable(tag);
  const today = useToday();
  const queryClient = useQueryClient();

  const defaultSorts = isEventTable ? EVENT_SORTS : GENERATED_SORTS;
  const view = useRecordTableState(defaultSorts);
  const [timeView, setTimeView] = useState<TimeView>(
    isEventTable ? "upcoming" : "all",
  );

  const columns = useMemo(
    () => buildColumns(isEventTable, rows),
    [isEventTable, rows],
  );

  const prefilter = useCallback(
    (input: TagTableRow[]) =>
      isEventTable
        ? input.filter((row) => eventMatchesTimeView(row, timeView))
        : input,
    [isEventTable, timeView],
  );

  const hasActiveView =
    view.isDirty || (isEventTable && timeView !== "upcoming");

  function resetView() {
    view.reset();
    if (isEventTable) setTimeView("upcoming");
  }

  async function bulkDelete(targets: TagTableRow[]) {
    const results = await Promise.allSettled(
      targets.map((row) => deleteRecord(row)),
    );
    // These rows are aggregated from many surfaces and were deleted via the
    // raw commands (not the per-type mutation hooks), so refresh every cache
    // a deleted record could appear in.
    await Promise.all(
      [
        ["tagTable"],
        ["tagsWithCounts"],
        ["notes"],
        ["people"],
        ["resources"],
        ["tasks"],
        ["areas"],
        ["events"],
        ["tables"],
        ["emails"],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );

    // Surface anything that didn't actually delete. Without this, a row the
    // backend can't remove (read-only iCal events) or that errored just
    // reappears after the selection clears — which reads as "delete is broken".
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "rejected") failed += 1;
      else if (result.value === "skipped") skipped += 1;
      else deleted += 1;
    }

    if (failed > 0) {
      toast.error(`Couldn't delete ${failed} ${pluralizeItem(failed)}`, {
        description:
          "Something went wrong removing the file — see Settings → Vault → Diagnostics.",
      });
    } else if (skipped > 0) {
      toast.warning(
        deleted > 0
          ? `Deleted ${deleted}, skipped ${skipped}`
          : `Couldn't delete ${skipped} ${pluralizeItem(skipped)}`,
        {
          description:
            "Some rows are read-only here — calendar events synced from Google can't be deleted from a tag table.",
        },
      );
    }
  }

  return (
    <RecordTable
      title={`#${tag}`}
      rows={rows}
      columns={columns}
      loading={isLoading}
      rowKey={(row) => `${row.type}:${row.id}:${row.path}:${row.date}`}
      rowHref={(row) => hrefForRow(row, today)}
      searchPlaceholder={isEventTable ? "Search events" : "Search rows"}
      query={view.query}
      onQueryChange={view.setQuery}
      filters={view.filters}
      onFiltersChange={view.setFilters}
      sorts={view.sorts}
      onSortsChange={view.setSorts}
      hasActiveView={hasActiveView}
      onResetView={resetView}
      prefilter={prefilter}
      rowLabel={(row) => row.title || "(untitled)"}
      onBulkDelete={bulkDelete}
      toolbarExtras={
        isEventTable ? (
          <TimeViewTabs active={timeView} rows={rows} onSelect={setTimeView} />
        ) : undefined
      }
    />
  );
}

// --- Columns --------------------------------------------------------------

function buildColumns(
  isEventTable: boolean,
  rows: TagTableRow[],
): RecordColumn<TagTableRow>[] {
  const areaOptions = selectOptionsFromValues(rows.map((row) => row.area));
  return isEventTable
    ? eventColumns(areaOptions)
    : generatedColumns(areaOptions, rows);
}

function titleColumn(name: string, icon: ElementType): RecordColumn<TagTableRow> {
  return {
    id: "title",
    name,
    type: "text",
    icon,
    width: 360,
    value: (row) => row.title,
    render: (row, href) => (
      <RecordLinkCell href={href} icon={typeIcons[row.type] ?? CircleDot}>
        {row.title}
      </RecordLinkCell>
    ),
  };
}

function eventColumns(areaOptions: SelectOption[]): RecordColumn<TagTableRow>[] {
  return [
    titleColumn("Event", CalendarDays),
    {
      id: "date",
      name: "When",
      type: "date",
      icon: CalendarDays,
      width: 180,
      value: (row) => row.date,
    },
    {
      id: "duration",
      name: "Duration",
      type: "number",
      icon: Clock3,
      width: 120,
      align: "right",
      value: (row) => row.event?.duration ?? null,
      render: (row) => (
        <span className="w-full text-right font-mono text-[12px] tabular-nums text-muted-foreground">
          {formatDuration(row.event?.duration)}
        </span>
      ),
    },
    {
      id: "attendees",
      name: "Attendees",
      type: "text",
      icon: User,
      width: 240,
      value: (row) => attendeeLabel(row) || null,
    },
    {
      id: "area",
      name: "Area",
      type: "select",
      icon: FolderKanban,
      width: 180,
      options: areaOptions,
      value: (row) => row.area || null,
    },
    {
      id: "provider",
      name: "Provider",
      type: "select",
      icon: Database,
      width: 130,
      options: providerOptions(),
      value: (row) => providerValue(row),
      render: (row) => <ProviderPill provider={row.event?.provider} />,
    },
    {
      id: "path",
      name: "Source",
      type: "text",
      icon: Link2,
      width: 280,
      mono: true,
      value: (row) => row.path,
    },
  ];
}

function generatedColumns(
  areaOptions: SelectOption[],
  rows: TagTableRow[],
): RecordColumn<TagTableRow>[] {
  const typeOptions = selectOptionsFromValues(
    rows.map((row) => row.type),
  ).map((option) => ({ ...option, name: labelForType(option.id) }));
  return [
    titleColumn("Title", FileText),
    {
      id: "type",
      name: "Type",
      type: "select",
      icon: Database,
      width: 150,
      options: typeOptions,
      value: (row) => row.type,
      render: (row) => {
        const Icon = typeIcons[row.type] ?? CircleDot;
        return (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Icon className="h-3.5 w-3.5" />
            <span>{labelForType(row.type)}</span>
          </span>
        );
      },
    },
    {
      id: "date",
      name: "Date",
      type: "date",
      icon: CalendarDays,
      width: 170,
      value: (row) => row.date,
    },
    {
      id: "area",
      name: "Area",
      type: "select",
      icon: FolderKanban,
      width: 170,
      options: areaOptions,
      value: (row) => row.area || null,
    },
    {
      id: "path",
      name: "Source",
      type: "text",
      icon: Link2,
      width: 280,
      mono: true,
      value: (row) => row.path,
    },
  ];
}

// --- Time-window tabs (event table only) ----------------------------------

function TimeViewTabs({
  active,
  rows,
  onSelect,
}: {
  active: TimeView;
  rows: TagTableRow[];
  onSelect: (view: TimeView) => void;
}) {
  const counts = useMemo(() => eventTimeCounts(rows), [rows]);
  const views: Array<{ value: TimeView; label: string }> = [
    { value: "upcoming", label: "Upcoming" },
    { value: "past", label: "Past" },
    { value: "all", label: "All" },
    { value: "undated", label: "No date" },
  ];

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
      {views.map((view) => (
        <button
          key={view.value}
          type="button"
          onClick={() => onSelect(view.value)}
          className={`flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[13px] transition-colors ${
            active === view.value
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          }`}
        >
          <span>{view.label}</span>
          <span className="font-mono text-[11px] text-muted-foreground/70">
            {counts[view.value]}
          </span>
        </button>
      ))}
    </div>
  );
}

function ProviderPill({ provider }: { provider?: string }) {
  const label = provider === "ical" ? "iCal" : "Vault";
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[12px] font-medium text-muted-foreground">
      {label}
    </span>
  );
}

// --- Row deletion ---------------------------------------------------------

/** `deleted` = a file was removed; `skipped` = nothing to delete here. */
type DeleteOutcome = "deleted" | "skipped";

async function deleteRecord(row: TagTableRow): Promise<DeleteOutcome> {
  switch (row.type) {
    case "note":
      await tauriInvoke("note_delete", { id: row.id });
      return "deleted";
    case "person":
      await tauriInvoke("person_delete", { id: row.id });
      return "deleted";
    case "resource":
      await tauriInvoke("resource_delete", { id: row.id });
      return "deleted";
    case "task":
      await tauriInvoke("task_delete", { id: row.id });
      return "deleted";
    case "area":
      await tauriInvoke("area_delete", { id: row.id });
      return "deleted";
    case "mail":
      // Removes the local message file (inbox/sent/archive) — a vault-local
      // removal that doesn't touch the Gmail mailbox. See mail_delete_one.
      await tauriInvoke("mail_delete_one", { id: row.id });
      return "deleted";
    case "event":
      // iCal events are a read-only calendar subscription cache — there's no
      // vault file to delete, so leave them in place.
      if (row.event?.provider === "ical") return "skipped";
      await tauriInvoke("event_delete", { id: row.id });
      return "deleted";
    case "row": {
      const tableId = tableIdFromRowPath(row.path);
      if (!tableId) return "skipped";
      await tauriInvoke("row_delete", { tableId, rowId: row.id });
      return "deleted";
    }
    default:
      // unknown — no safe delete from this surface.
      return "skipped";
  }
}

function pluralizeItem(count: number) {
  return count === 1 ? "item" : "items";
}

// --- Routing + formatting helpers -----------------------------------------

function hrefForRow(row: TagTableRow, today: string): string {
  if (row.type === "event") {
    const event = row.event;
    const occurrenceDate = (event?.date ?? row.date).slice(0, 10);
    if (event?.provider === "ical" && event.accountId && event.externalId) {
      return `/cadence/event/ical/${encodeURIComponent(event.accountId)}/${encodeURIComponent(event.externalId)}?date=${occurrenceDate}`;
    }
    return `/cadence/event/${encodeURIComponent(row.id)}`;
  }
  if (row.type === "task") {
    // Unscheduled tasks have no cadence day of their own; open them in today's
    // context (the editor loads by id regardless of the date segment).
    const scheduled = row.date.slice(0, 10);
    return `/cadence/${scheduled || today}/task/${encodeURIComponent(row.id)}`;
  }
  if (row.type === "note") return `/notebook/${encodeURIComponent(row.id)}`;
  if (row.type === "person") return `/people/${encodeURIComponent(row.id)}`;
  if (row.type === "resource") return `/resources/${encodeURIComponent(row.id)}`;
  if (row.type === "area") return `/areas/${encodeURIComponent(row.id)}`;
  if (row.type === "mail") return `/mail/${encodeURIComponent(row.id)}`;
  if (row.type === "row") {
    const tableId = tableIdFromRowPath(row.path);
    if (tableId) {
      return `/databases/${encodeURIComponent(tableId)}/${encodeURIComponent(row.id)}`;
    }
  }
  return "/";
}

function tableIdFromRowPath(path: string) {
  // Vault path shape is `tables/<table-id>/<row-id>.md` — the on-disk folder
  // is still `tables/` even though the surface is now "Databases".
  const parts = path.split("/");
  return parts[0] === "tables" && parts[1] ? parts[1] : "";
}

function cleanTag(value: string) {
  try {
    return decodeURIComponent(value).replace(/^#/, "").trim();
  } catch {
    return value.replace(/^#/, "").trim();
  }
}

function labelForType(value: string) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function attendeeLabel(row: TagTableRow) {
  const attendees = row.event?.resolvedAttendees ?? [];
  if (attendees.length > 0) {
    return attendees
      .map((attendee) => attendee.name || attendee.email || attendee.raw)
      .filter(Boolean)
      .join(", ");
  }
  return (row.event?.attendees ?? []).join(", ");
}

function formatDuration(value: number | undefined) {
  if (!value) return "Empty";
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function dateValue(value: string): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function eventMatchesTimeView(row: TagTableRow, view: TimeView): boolean {
  if (view === "all") return true;
  const time = dateValue(row.date);
  if (view === "undated") return time === null;
  if (time === null) return false;
  const today = startOfToday();
  if (view === "upcoming") return time >= today;
  return time < today;
}

function eventTimeCounts(rows: TagTableRow[]): Record<TimeView, number> {
  return {
    upcoming: rows.filter((row) => eventMatchesTimeView(row, "upcoming")).length,
    past: rows.filter((row) => eventMatchesTimeView(row, "past")).length,
    all: rows.length,
    undated: rows.filter((row) => eventMatchesTimeView(row, "undated")).length,
  };
}

function providerValue(row: TagTableRow): string {
  return row.event?.provider === "ical" ? "ical" : "vault";
}

function providerOptions(): SelectOption[] {
  return [
    { id: "vault", name: "Vault", color: "gray" },
    { id: "ical", name: "iCal", color: "blue" },
  ];
}
