import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarDays,
  CircleDashed,
  ListFilter,
  Plus,
  Search,
} from "lucide-react";
import { NewAreaForm } from "@/components/areas/new-area-form";
import {
  buildAreaItems,
  formatAreaItemDate,
  previewMarkdown,
  type AreaItemType,
  type UnifiedItem,
} from "@/lib/area-activity";
import { defaultAreas, UNASSIGNED_AREA_ID } from "@/lib/areas";
import { useAreas } from "@/lib/hooks/use-areas";
import { useAllNotes } from "@/lib/hooks/use-notes";
import { useAllPeople } from "@/lib/hooks/use-people";
import { useAllTasks } from "@/lib/hooks/use-tasks";
import { useTagTable } from "@/lib/hooks/use-tag-table";
import { useToday } from "@/lib/hooks/use-today";
import type { Area } from "@/lib/types";
import { cn } from "@/lib/utils";

type SortMode = "name" | "activity";

interface AreaSummary {
  area: Area;
  counts: Record<AreaItemType, number>;
  total: number;
  latest: UnifiedItem | undefined;
}

const EMPTY_COUNTS: Record<AreaItemType, number> = {
  event: 0,
  task: 0,
  note: 0,
  person: 0,
};

export function AreasList() {
  const navigate = useNavigate();
  const { data: liveAreas, isLoading } = useAreas();
  const { data: notes = [] } = useAllNotes();
  const { data: people = [] } = useAllPeople();
  const { data: tasks = [] } = useAllTasks();
  const { data: eventRows = [] } = useTagTable("event");
  const today = useToday();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("name");

  const areas = liveAreas ?? defaultAreas;
  const allItems = useMemo(
    () =>
      buildAreaItems({
        events: eventRows,
        tasks,
        notes,
        people,
        area: null,
        today,
      }),
    [eventRows, notes, people, tasks, today],
  );

  const summaries = useMemo(
    () => buildAreaSummaries(areas, allItems, today),
    [allItems, areas, today],
  );

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const next = normalizedQuery
      ? summaries.filter(({ area }) =>
          `${area.name} ${previewMarkdown(area.description ?? "")}`
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        )
      : summaries;
    return next.toSorted((a, b) => {
      if (sort === "activity") {
        const dateOrder = (b.latest?.date ?? "").localeCompare(
          a.latest?.date ?? "",
        );
        if (dateOrder !== 0) return dateOrder;
      }
      return a.area.name.localeCompare(b.area.name);
    });
  }, [query, sort, summaries]);

  return (
    <div className="mx-auto w-full max-w-[1040px] pb-24">
      <header className="mb-8 w-full">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="min-w-0 text-[32px] font-bold leading-tight tracking-normal text-foreground">
              Areas
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
              {query.trim() && `${visible.length} / `}
              {summaries.length} areas
            </span>
            {!creating ? (
              <button
                type="button"
                aria-label="New area"
                onClick={() => setCreating(true)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
              >
                <Plus className="h-4 w-4" strokeWidth={1.7} />
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {creating ? (
        <section className="mb-7 border-y border-border/70 py-5">
          <NewAreaForm
            label="Create an area"
            onCreated={(area) => {
              setCreating(false);
              void navigate({ to: "/areas/$area", params: { area: area.id } });
            }}
            onCancel={() => setCreating(false)}
          />
        </section>
      ) : null}

      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block w-full sm:max-w-[320px]">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/75"
          />
          <span className="sr-only">Search areas</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find an area"
            className="h-8 w-full rounded-md border-0 bg-foreground/[0.035] pl-8 pr-3 text-[12.5px] outline-none transition-colors placeholder:text-muted-foreground/65 focus:bg-foreground/[0.05] focus:ring-1 focus:ring-border"
          />
        </label>
        <div className="flex items-center gap-1 text-[12px]">
          <span className="mr-1 hidden font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground sm:inline">
            Sort
          </span>
          <SortButton
            active={sort === "name"}
            onClick={() => setSort("name")}
            icon={ListFilter}
          >
            Name
          </SortButton>
          <SortButton
            active={sort === "activity"}
            onClick={() => setSort("activity")}
            icon={CalendarDays}
          >
            Activity
          </SortButton>
        </div>
      </div>

      {isLoading && !liveAreas ? (
        <div className="divide-y divide-border/60 border-y border-border/70">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="h-[84px] animate-pulse bg-muted/20"
            />
          ))}
        </div>
      ) : visible.length > 0 ? (
        <div className="border-y border-border/70">
          <div className="hidden grid-cols-[minmax(0,1fr)_220px_240px_16px] gap-6 border-b border-border/60 px-1 py-2 font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground/70 md:grid">
            <span>Area</span>
            <span>Records</span>
            <span>Latest</span>
            <span />
          </div>
          {visible.map((summary) => (
            <AreaRow key={summary.area.id} summary={summary} />
          ))}
        </div>
      ) : (
        <div className="border-y border-border/70 py-16 text-center">
          <p className="text-sm font-medium text-foreground">
            No matching areas
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Try another name or clear the search.
          </p>
        </div>
      )}
    </div>
  );
}

function AreaRow({ summary }: { summary: AreaSummary }) {
  const { area, counts, latest, total } = summary;
  const isUnassigned = area.id === UNASSIGNED_AREA_ID;
  const description = isUnassigned
    ? "Records that have not been assigned to an area."
    : previewMarkdown(area.description ?? "") || "No description yet.";

  return (
    <Link
      to="/areas/$area"
      params={{ area: area.id }}
      className="group grid min-h-[84px] grid-cols-[minmax(0,1fr)_16px] items-center gap-4 border-b border-border/55 px-1 py-4 transition-colors last:border-b-0 hover:bg-foreground/[0.025] focus:outline-none focus-visible:bg-foreground/[0.04] md:grid-cols-[minmax(0,1fr)_220px_240px_16px] md:gap-6"
    >
      <div className="flex min-w-0 items-start gap-3">
        {isUnassigned ? (
          <CircleDashed className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span
            aria-hidden
            className="mt-[7px] h-2 w-2 shrink-0 rounded-full"
            style={{ background: area.color }}
          />
        )}
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-medium text-foreground">
            {area.name}
          </h2>
          <p className="mt-1 truncate text-[12px] text-muted-foreground/80">
            {description}
          </p>
        </div>
      </div>

      <div className="hidden min-w-0 md:block">
        <div className="font-mono text-[12px] tabular-nums text-foreground/85">
          {total} {total === 1 ? "record" : "records"}
        </div>
        <div className="mt-1 truncate text-[10.5px] text-muted-foreground/70">
          {formatBreakdown(counts)}
        </div>
      </div>

      <div className="hidden min-w-0 md:block">
        {latest ? (
          <>
            <div className="truncate text-[12px] text-foreground/80">
              {latest.title}
            </div>
            <div className="mt-1 font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {formatAreaItemDate(latest.date)}
            </div>
          </>
        ) : (
          <span className="text-[12px] text-muted-foreground/60">No activity</span>
        )}
      </div>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
    </Link>
  );
}

function formatBreakdown(counts: Record<AreaItemType, number>) {
  return [
    [counts.event, "events"],
    [counts.task, "tasks"],
    [counts.note, "notes"],
    [counts.person, "people"],
  ]
    .filter(([value]) => value !== 0)
    .map(([value, label]) => `${value} ${label}`)
    .join(" · ") || "No records";
}

function SortButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof ListFilter;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded px-2 text-[11.5px] font-medium transition-colors",
        active
          ? "bg-foreground/[0.065] text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={1.8} />
      {children}
    </button>
  );
}

function buildAreaSummaries(
  areas: Area[],
  items: UnifiedItem[],
  today: string,
): AreaSummary[] {
  const rows: Area[] = [
    ...areas,
    {
      id: UNASSIGNED_AREA_ID,
      name: "Unassigned",
      color: "",
      description: "Records without an area",
    },
  ];
  const knownIds = new Set(areas.map((area) => area.id));
  const itemsByArea = new Map<string, UnifiedItem[]>();

  for (const item of items) {
    const key =
      item.area && knownIds.has(item.area) ? item.area : UNASSIGNED_AREA_ID;
    const bucket = itemsByArea.get(key);
    if (bucket) bucket.push(item);
    else itemsByArea.set(key, [item]);
  }

  return rows.map((area) => {
    const areaItems = itemsByArea.get(area.id) ?? [];
    const counts = { ...EMPTY_COUNTS };
    for (const item of areaItems) counts[item.type] += 1;
    const latest = areaItems.find(
      (item) => item.date && item.date.slice(0, 10) <= today,
    );
    return { area, counts, total: areaItems.length, latest };
  });
}
