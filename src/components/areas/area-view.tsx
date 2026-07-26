import { useMemo, useState, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { CircleDashed } from "lucide-react";
import { BacklinksPanel } from "@/components/shared/backlinks-panel";
import { OutgoingLinksPanel } from "@/components/shared/outgoing-links-panel";
import { TiptapEditor } from "@/components/shared/tiptap-editor";
import { getAreaName, UNASSIGNED_AREA_ID } from "@/lib/areas";
import { useAreaMutations, useAreas } from "@/lib/hooks/use-areas";
import { useAllNotes } from "@/lib/hooks/use-notes";
import { useAllPeople } from "@/lib/hooks/use-people";
import { useAllTasks } from "@/lib/hooks/use-tasks";
import { useTagTable } from "@/lib/hooks/use-tag-table";
import { useToday } from "@/lib/hooks/use-today";
import {
  areaItemIcons,
  buildAreaItems,
  formatAreaItemDate,
  type AreaItemType,
  type UnifiedItem,
} from "@/lib/area-activity";
import type { AreaId } from "@/lib/types";
import { cn } from "@/lib/utils";

type FileType = "all" | AreaItemType;

const TYPE_FILTERS: {
  key: FileType;
  label: string;
  singular: string;
}[] = [
  { key: "all", label: "All", singular: "record" },
  { key: "event", label: "Events", singular: "event" },
  { key: "task", label: "Tasks", singular: "task" },
  { key: "note", label: "Notes", singular: "note" },
  { key: "person", label: "People", singular: "person" },
];

interface AreaViewProps {
  area: AreaId;
}

export function SpaceView({ area }: AreaViewProps) {
  return <AreaView area={area} />;
}

export function AreaView({ area }: AreaViewProps) {
  const [filter, setFilter] = useState<FileType>("all");
  const { data: areas = [] } = useAreas();
  const { data: liveNotes = [] } = useAllNotes();
  const { data: livePeople = [] } = useAllPeople();
  const { data: liveTasks = [] } = useAllTasks();
  const { data: eventRows = [] } = useTagTable("event");
  const { update } = useAreaMutations();
  const today = useToday();

  const isUnassigned = area === UNASSIGNED_AREA_ID;
  const areaRecord = areas.find((candidate) => candidate.id === area);
  const title = isUnassigned ? "Unassigned" : getAreaName(area, areas);
  const accent = isUnassigned
    ? "var(--muted-foreground)"
    : areaRecord?.color || "var(--foreground)";

  const items = useMemo(
    () =>
      buildAreaItems({
        events: eventRows,
        tasks: liveTasks,
        notes: liveNotes,
        people: livePeople,
        area,
        today,
      }),
    [area, eventRows, liveNotes, livePeople, liveTasks, today],
  );

  const counts = useMemo(() => countByType(items), [items]);
  const filtered = useMemo(
    () =>
      filter === "all" ? items : items.filter((item) => item.type === filter),
    [filter, items],
  );
  const style = { "--area-accent": accent } as CSSProperties;

  async function commitDescription(next: string) {
    if (!areaRecord || next === (areaRecord.description ?? "")) return;
    await update.mutateAsync({
      id: areaRecord.id,
      update: { description: next },
    });
  }

  return (
    <div
      style={style}
      className="mx-auto w-full max-w-[900px] pb-24 animate-in fade-in duration-300"
    >
      <header className="mb-8 border-b border-border/70 pb-7">
        <div className="flex min-w-0 items-center gap-3">
          {isUnassigned ? (
            <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--area-accent)]" />
          )}
          <h1 className="min-w-0 flex-1 truncate text-[34px] font-semibold leading-tight tracking-[-0.03em] text-foreground">
            {title}
          </h1>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {items.length} {items.length === 1 ? "record" : "records"}
          </span>
        </div>
      </header>

      {!isUnassigned && areaRecord ? (
        <section className="mb-9 border-b border-border/70 pb-8">
          <div className="max-w-2xl">
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">
              About
            </div>
            <TiptapEditor
              value={areaRecord.description ?? ""}
              onCommit={commitDescription}
              placeholder="Add a short description…"
              className="min-h-[48px] text-[14px] leading-6 text-foreground"
              scrollPastEnd={false}
            />
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-1 flex flex-col gap-3 border-b border-border/70 sm:flex-row sm:items-end sm:justify-between">
          <h2 className="pb-3 text-[18px] font-semibold tracking-[-0.015em] text-foreground">
            Records
          </h2>
          <div
            role="tablist"
            aria-label="Filter area records"
            className="flex max-w-full items-end gap-4 overflow-x-auto"
          >
            {TYPE_FILTERS.map(({ key, label }) => {
              const value = key === "all" ? items.length : counts[key];
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={filter === key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    "relative flex h-9 shrink-0 items-center gap-1.5 text-[11.5px] font-medium transition-colors after:absolute after:inset-x-0 after:-bottom-px after:h-px after:origin-left after:bg-[var(--area-accent)] after:transition-transform",
                    filter === key
                      ? "text-foreground after:scale-x-100"
                      : "text-muted-foreground after:scale-x-0 hover:text-foreground",
                  )}
                >
                  {label}
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    {value}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {filtered.length > 0 ? (
          <div className="divide-y divide-border/55">
            {filtered.map((item) => (
              <ActivityRow
                key={`${item.type}:${item.id}:${item.href}`}
                item={item}
              />
            ))}
          </div>
        ) : (
          <EmptyState filter={filter} />
        )}
      </section>

      {!isUnassigned ? (
        <div className="mt-14 border-t border-border/70 pt-2">
          <OutgoingLinksPanel sourceId={area} />
          <BacklinksPanel targetId={area} />
        </div>
      ) : null}
    </div>
  );
}

function ActivityRow({ item }: { item: UnifiedItem }) {
  const Icon = areaItemIcons[item.type];
  const typeLabel = TYPE_FILTERS.find(({ key }) => key === item.type)?.label;
  return (
    <Link
      to={item.href}
      className="group grid min-w-0 grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-3 border-b border-border/50 px-1 py-3 transition-colors [content-visibility:auto] [contain-intrinsic-size:56px] last:border-b-0 hover:bg-foreground/[0.025] focus:outline-none focus-visible:bg-foreground/[0.04]"
    >
      <span className="flex h-5 items-center justify-center text-muted-foreground/75 transition-colors group-hover:text-foreground">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.6} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-medium text-foreground">
          {item.title}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[10.5px] text-muted-foreground/75">
          <span className="shrink-0">
            {typeLabel}
          </span>
          <span aria-hidden>·</span>
          <span className="truncate">{item.subtitle || item.filePath}</span>
        </span>
      </span>
      <span className="pt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/75">
        {item.date ? formatAreaItemDate(item.date) : "Directory"}
      </span>
    </Link>
  );
}

function EmptyState({ filter }: { filter: FileType }) {
  const definition = TYPE_FILTERS.find(({ key }) => key === filter);
  const label = definition?.singular ?? "record";
  return (
    <div className="border-b border-border/70 py-14 text-center">
      <p className="text-sm font-medium text-foreground">
        No {filter === "all" ? "records" : definition?.label.toLowerCase()} here
        yet
      </p>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Assign a {label} to this area and it will appear here.
      </p>
    </div>
  );
}

function countByType(items: UnifiedItem[]) {
  return items.reduce(
    (acc, item) => {
      acc[item.type] += 1;
      return acc;
    },
    { event: 0, task: 0, note: 0, person: 0 },
  );
}
