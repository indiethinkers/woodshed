import { useMemo, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { CircleDashed, LayoutGrid } from "lucide-react";
import {
  ListSidebar,
  ListSidebarEmpty,
  ListSidebarPrimaryAction,
  ListSidebarRow,
  ListSidebarRows,
} from "@/components/shared/list-sidebar";
import { defaultAreas, UNASSIGNED_AREA_ID } from "@/lib/areas";
import { useAreas } from "@/lib/hooks/use-areas";
import { useAllNotes } from "@/lib/hooks/use-notes";
import { useAllPeople } from "@/lib/hooks/use-people";
import { useAllTasks } from "@/lib/hooks/use-tasks";
import { useTagTable } from "@/lib/hooks/use-tag-table";
import { useToday } from "@/lib/hooks/use-today";
import {
  areaItemIcons,
  buildAreaItems,
  formatAreaItemDate,
} from "@/lib/area-activity";
import { NewAreaForm } from "./new-area-form";

// Areas list panel: every area plus the virtual Unassigned bucket.
export function AreasSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: liveAreas } = useAreas();
  const areas = liveAreas ?? defaultAreas;
  const unassignedHref = `/areas/${UNASSIGNED_AREA_ID}`;

  return (
    <ListSidebar>
      <AreaSidebarCreateControl />
      {areas.length === 0 ? (
        <ListSidebarEmpty>No areas yet.</ListSidebarEmpty>
      ) : (
        <ListSidebarRows>
          <ListSidebarRow
            href="/areas"
            title="All areas"
            leading={
              <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
            }
          />
          <div className="my-2 h-px bg-border/70" />
          {areas.map((area) => {
            const href = `/areas/${area.id}`;
            return (
              <ListSidebarRow
                key={area.id}
                href={href}
                active={pathname === href}
                title={area.name}
                leading={
                  <span
                    aria-hidden
                    className="block h-2.5 w-2.5 rounded-full"
                    style={{ background: area.color }}
                  />
                }
              />
            );
          })}
          <ListSidebarRow
            href={unassignedHref}
            active={pathname === unassignedHref}
            title="Unassigned"
            leading={<CircleDashed className="h-3 w-3 text-muted-foreground" />}
          />
        </ListSidebarRows>
      )}
    </ListSidebar>
  );
}

// The index sidebar is deliberately a restrained pulse, not a second content
// surface. One-line rows and a short cap preserve context without competing
// with the area overview in the main panel.
const RECENT_LIMIT = 10;

export function AreasRecentSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: areas = [] } = useAreas();
  const { data: notes = [] } = useAllNotes();
  const { data: people = [] } = useAllPeople();
  const { data: tasks = [] } = useAllTasks();
  const { data: eventRows = [] } = useTagTable("event");
  const today = useToday();

  const items = useMemo(
    () =>
      buildAreaItems({
        events: eventRows,
        tasks,
        notes,
        people,
        area: null,
        today,
      })
        // A chronological feed only makes sense for dated records; people
        // carry no activity timestamp, so they're omitted here (they still
        // appear in each area's detail view). Cap at today so "Recent"
        // reads as what's happened — upcoming calendar events live on
        // Cadence, not in this backward-looking pulse.
        .filter((item) => item.date && item.date.slice(0, 10) <= today)
        .slice(0, RECENT_LIMIT),
    [eventRows, tasks, notes, people, today],
  );

  return (
    <ListSidebar>
      <AreaSidebarCreateControl />
      {items.length === 0 ? (
        <ListSidebarEmpty>No recent activity yet.</ListSidebarEmpty>
      ) : (
        <div className="space-y-0.5">
          <Link
            to="/areas"
            aria-current="page"
            className="mb-3 flex h-8 items-center gap-2 rounded-md bg-foreground/[0.055] px-2 text-[12.5px] font-medium text-foreground"
          >
            <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
            Overview
            <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
              {areas.length}
            </span>
          </Link>
          <div className="mb-2 flex items-center gap-2 px-2">
            <span className="font-mono text-[9px] font-medium uppercase tracking-[0.17em] text-muted-foreground/80">
              Recently changed
            </span>
            <span className="h-px flex-1 bg-border/70" />
          </div>
          {items.map((item) => {
            const Icon = areaItemIcons[item.type];
            const areaRecord = areas.find((area) => area.id === item.area);
            return (
              <Link
                key={`${item.type}:${item.id}`}
                to={item.href}
                title={`${item.title} · ${areaRecord?.name ?? "Unassigned"}`}
                aria-current={pathname === item.href ? "page" : undefined}
                className={`group flex h-8 min-w-0 items-center gap-2 rounded-md px-2 transition-colors ${
                  pathname === item.href
                    ? "bg-foreground/[0.055]"
                    : "hover:bg-foreground/[0.04]"
                }`}
              >
                <Icon className="h-3 w-3 shrink-0 text-muted-foreground/80" />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/90">
                  {item.title}
                </span>
                <span
                  aria-label={areaRecord?.name ?? "Unassigned"}
                  className="h-1.5 w-1.5 shrink-0 rounded-full border border-border"
                  style={{
                    background: areaRecord?.color ?? "transparent",
                  }}
                />
                <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/70">
                  {formatAreaItemDate(item.date)}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </ListSidebar>
  );
}

function AreaSidebarCreateControl() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  if (!creating) {
    return (
      <ListSidebarPrimaryAction
        label="New area"
        onClick={() => setCreating(true)}
      />
    );
  }

  return (
    <div className="mb-5 rounded-md border border-border bg-background/50 p-3">
      <NewAreaForm
        compact
        onCreated={(area) => {
          setCreating(false);
          void navigate({ to: "/areas/$area", params: { area: area.id } });
        }}
        onCancel={() => setCreating(false)}
      />
    </div>
  );
}
