import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Popover } from "@base-ui/react/popover";
import {
  CalendarDays,
  Check,
  ChevronsDown,
  ChevronsUp,
  FileText,
  Funnel,
  Pause,
  Play,
  Plus,
} from "lucide-react";
import { CalendarGrid } from "./date-picker";
import { addMonths, monthStart } from "./date-utils";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRightSidebar } from "@/components/layout/right-sidebar-context-internal";
import { RichText } from "@/components/shared/rich-text";
import { useTabs } from "@/components/layout/tabs-context-internal";
import { DaybookSectionHeader } from "./daybook-section-header";
import { Area, AreaId, TaskStatus } from "@/lib/types";
import {
  defaultAreas,
  getAreaName,
} from "@/lib/areas";
import { useToday } from "@/lib/hooks/use-today";
import { useCadenceSidebarDate } from "@/lib/cadence/use-cadence-sidebar-date";
import { extractDate } from "@/lib/cadence/sidebar-date";
import { useAreas } from "@/lib/hooks/use-areas";
import { NewAreaForm } from "@/components/areas/new-area-form";
import { formatDuration, liveTimeSpent } from "@/lib/format-duration";
import { useDisplayNow } from "@/lib/demo-clock";
import {
  useTasks,
  useAllTasks,
  useTaskMutations,
  type TaskDto,
} from "@/lib/hooks/use-tasks";

const STATUS_ORDER: TaskStatus[] = ["in-progress", "backlog", "done"];
const SECTION_ORDER: TaskStatus[] = ["in-progress", "backlog", "done"];
const INLINE_TASKS_COLLAPSED_STORAGE_KEY =
  "woodshed:cadence:inline-tasks-collapsed";
type TaskScope = "today" | "week" | "all";
type TaskListVariant = "sidebar" | "inline";

interface StatusGroup {
  status: TaskStatus;
  tasks: TaskDto[];
}

interface TaskOpenPointerIntent {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
}

export function TaskSidebar() {
  return <TaskList variant="sidebar" />;
}

export function DailyTasks({ date }: { date: string }) {
  return <TaskList date={date} variant="inline" />;
}

function TaskList({
  date: providedDate,
  variant,
}: {
  date?: string;
  variant: TaskListVariant;
}) {
  const sidebarDate = useCadenceSidebarDate();
  const today = useToday();
  const date = providedDate ?? sidebarDate;
  const { data: dayTasks = [] } = useTasks(date);
  const { data: allTasks } = useAllTasks();
  const { data: liveAreas } = useAreas();
  const { create, reorder } = useTaskMutations();
  const areas = liveAreas ?? defaultAreas;

  const [creating, setCreating] = useState(false);
  const [scope, setScope] = useState<TaskScope>("today");
  const [statusFilter, setStatusFilter] =
    useState<TaskStatus[]>(STATUS_ORDER);
  const [areaFilter, setAreaFilter] = useState<AreaId[]>([]);
  const [inlineCollapsed, setInlineCollapsed] = useState(
    () => variant === "inline" && readInlineTasksCollapsed(),
  );
  const [inlineActiveExpanded, setInlineActiveExpanded] = useState(false);
  const suppressTaskOpenUntilRef = useRef(0);

  // 4px activation threshold so a click on the card-shaped link doesn't
  // start a drag. Anything beyond a quick click counts as a drag intent.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleCreate(content: string, area: AreaId) {
    const trimmed = content.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    create.mutate({
      content: trimmed,
      area,
      scheduled: date,
    });
    setCreating(false);
  }

  const taskPool = allTasks ?? dayTasks;
  const openTaskPool = useMemo(
    () => taskPool.filter((task) => task.status !== "done"),
    [taskPool],
  );
  const weekTasks = useMemo(
    () => taskPool.filter((task) => isTaskInWeek(task, date)),
    [taskPool, date],
  );

  const scopedTasks = useMemo(() => {
    switch (scope) {
      case "week":
        return weekTasks;
      case "all":
        return openTaskPool;
      case "today":
      default:
        return dayTasks;
    }
  }, [dayTasks, openTaskPool, scope, weekTasks]);

  const visibleTasks = scopedTasks.filter(
    (task) =>
      statusFilter.includes(task.status) &&
      (areaFilter.length === 0 || areaFilter.includes(task.area)),
  );

  const groupedTasks: StatusGroup[] = SECTION_ORDER.map((status) => ({
    status,
    tasks: sortTasksForSection(
      visibleTasks.filter((task) => task.status === status),
    ),
  })).filter((group) => group.tasks.length > 0);

  const backlogTasks =
    groupedTasks.find((group) => group.status === "backlog")?.tasks ?? [];
  const inlineActiveTasks =
    variant === "inline"
      ? sortTasksForSection(
          visibleTasks.filter((task) => task.status === "in-progress"),
        )
      : [];
  const inlineActiveFocus = inlineActiveTasks.length > 0;
  const inlineEffectivelyCollapsed =
    variant === "inline" &&
    (inlineCollapsed || (inlineActiveFocus && !inlineActiveExpanded));
  const collapsedActiveTasks =
    variant === "inline" && inlineEffectivelyCollapsed
      ? inlineActiveTasks
      : [];
  const collapsedHiddenCount = Math.max(
    0,
    visibleTasks.length - collapsedActiveTasks.length,
  );

  const counts = {
    today: dayTasks.length,
    week: weekTasks.length,
    all: openTaskPool.length,
  };

  const visibleCount = visibleTasks.length;
  const isEmpty = visibleTasks.length === 0;
  const canReorderBacklog = scope === "today";
  const filtersActive =
    statusFilter.length !== STATUS_ORDER.length || areaFilter.length > 0;

  useEffect(() => {
    if (!inlineActiveFocus) {
      setInlineActiveExpanded(false);
    }
  }, [inlineActiveFocus]);

  function toggleStatusFilter(status: TaskStatus) {
    setStatusFilter((current) =>
      current.includes(status)
        ? current.filter((item) => item !== status)
        : [...current, status],
    );
  }

  function toggleAreaFilter(area: AreaId) {
    setAreaFilter((current) =>
      current.includes(area)
        ? current.filter((item) => item !== area)
        : [...current, area],
    );
  }

  function resetFilters() {
    setStatusFilter(STATUS_ORDER);
    setAreaFilter([]);
  }

  function handleAdd() {
    setInlineCollapsedPreference(false);
    setCreating(true);
  }

  function setInlineCollapsedPreference(collapsed: boolean) {
    setInlineCollapsed(collapsed);
    if (variant === "inline") {
      setInlineActiveExpanded(!collapsed && inlineActiveFocus);
      writeInlineTasksCollapsed(collapsed);
    }
  }

  function toggleInlineCollapsedPreference() {
    setInlineCollapsedPreference(!inlineEffectivelyCollapsed);
  }

  function suppressTaskOpenAfterDrag() {
    suppressTaskOpenUntilRef.current = performance.now() + 350;
  }

  function suppressTaskOpenDuringDrag() {
    suppressTaskOpenUntilRef.current = Number.POSITIVE_INFINITY;
  }

  function shouldSuppressTaskOpen() {
    const shouldSuppress = performance.now() < suppressTaskOpenUntilRef.current;
    if (shouldSuppress) {
      suppressTaskOpenUntilRef.current = 0;
    }
    return shouldSuppress;
  }

  function handleDragEnd(e: DragEndEvent) {
    suppressTaskOpenAfterDrag();
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const list = backlogTasks;
    const fromIdx = list.findIndex((t) => t.id === active.id);
    const toIdx = list.findIndex((t) => t.id === over.id);
    if (fromIdx === -1 || toIdx === -1) return;

    // Compute the new neighbors as if the moved item already sat at toIdx.
    // The dragged item is removed from its old position first so prev/next
    // don't include itself.
    const without = list.filter((_, i) => i !== fromIdx);
    const insertAt = fromIdx < toIdx ? toIdx : toIdx;
    const prev = without[insertAt - 1];
    const next = without[insertAt];

    let newSortKey: number;
    if (prev && next) {
      newSortKey = (prev.sortKey + next.sortKey) / 2;
    } else if (prev) {
      newSortKey = prev.sortKey + 1000;
    } else if (next) {
      newSortKey = next.sortKey - 1000;
    } else {
      newSortKey = 0;
    }

    reorder.mutate({ id: String(active.id), sortKey: newSortKey });
  }

  return (
    <section
      data-task-sidebar
      className={variant === "inline" ? "mt-10" : "pb-5"}
    >
      <Header
        variant={variant}
        count={visibleCount}
        counts={counts}
        scope={scope}
        areas={areas}
        statusFilter={statusFilter}
        areaFilter={areaFilter}
        filtersActive={filtersActive}
        onScopeChange={setScope}
        onToggleStatus={toggleStatusFilter}
        onToggleArea={toggleAreaFilter}
        onResetFilters={resetFilters}
        onResetStatus={() => setStatusFilter(STATUS_ORDER)}
        onResetAreas={() => setAreaFilter([])}
        onAdd={handleAdd}
        collapsed={variant === "inline" ? inlineEffectivelyCollapsed : false}
        onToggleCollapsed={
          variant === "inline" ? toggleInlineCollapsedPreference : undefined
        }
      />
      <div
        className={
          variant === "inline"
            ? inlineEffectivelyCollapsed || (isEmpty && !creating)
              ? "mt-3"
              : "mt-5"
            : "px-3 pt-5"
        }
      >
        {inlineEffectivelyCollapsed && variant === "inline" ? (
          <>
            {creating && (
              <div className="mb-5">
                <NewTaskCard
                  onSubmit={handleCreate}
                  onCancel={() => setCreating(false)}
                />
              </div>
            )}
            <CollapsedInlineTasks
              activeTasks={collapsedActiveTasks}
              areas={areas}
              date={date}
              hiddenCount={collapsedHiddenCount}
              onCompleteActive={() => setInlineCollapsedPreference(false)}
            />
          </>
        ) : (
          <>
            {creating && (
              <div className="mb-5">
                <NewTaskCard
                  onSubmit={handleCreate}
                  onCancel={() => setCreating(false)}
                />
              </div>
            )}
            {isEmpty && !creating ? (
              // Sidebar shows no empty state — just a clean, quiet rail. The
              // inline (daily-page) list keeps its single-line note.
              variant === "inline" ? (
                <p className="px-0 py-1 text-[13px] leading-tight text-muted-foreground">
                  {emptyTaskMessage(scope, date, filtersActive, variant)}
                </p>
              ) : null
            ) : (
              groupedTasks.map((group, i) => (
                <section
                  key={group.status}
                  className={
                    i === 0 ? "" : variant === "inline" ? "mt-3" : "mt-5"
                  }
                >
                  {variant === "sidebar" && (
                    <SectionHeader
                      status={group.status}
                      count={group.tasks.length}
                    />
                  )}
                  <div
                    className={
                      variant === "sidebar"
                        ? group.status === "in-progress"
                          ? "space-y-3"
                          : "space-y-0.5"
                        : "space-y-2.5"
                    }
                  >
                    {group.status === "backlog" && canReorderBacklog ? (
                      <DndContext
                        id="task-sidebar-backlog"
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragStart={suppressTaskOpenDuringDrag}
                        onDragCancel={suppressTaskOpenAfterDrag}
                        onDragEnd={handleDragEnd}
                      >
                        <SortableContext
                          items={group.tasks.map((t) => t.id)}
                          strategy={verticalListSortingStrategy}
                        >
                          {group.tasks.map((task) => (
                            <SortableTaskCard
                              key={task.id}
                              task={task}
                              date={date}
                              areas={areas}
                              variant={variant}
                              onSetActive={
                                variant === "inline"
                                  ? () => setInlineCollapsedPreference(true)
                                  : undefined
                              }
                              onCompleteActive={
                                variant === "inline"
                                  ? () => setInlineCollapsedPreference(false)
                                  : undefined
                              }
                              shouldSuppressOpen={shouldSuppressTaskOpen}
                            />
                          ))}
                        </SortableContext>
                      </DndContext>
                    ) : (
                      group.tasks.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          date={date}
                          areas={areas}
                          variant={variant}
                          onSetActive={
                            variant === "inline"
                              ? () => setInlineCollapsedPreference(true)
                              : undefined
                          }
                          onCompleteActive={
                            variant === "inline"
                              ? () => setInlineCollapsedPreference(false)
                              : undefined
                          }
                        />
                      ))
                    )}
                  </div>
                </section>
              ))
            )}
          </>
        )}
      </div>
    </section>
  );
}

function SortableTaskCard({
  task,
  date,
  areas,
  variant,
  onSetActive,
  onCompleteActive,
  shouldSuppressOpen,
}: {
  task: TaskDto;
  date: string;
  areas: Area[];
  variant: TaskListVariant;
  onSetActive?: () => void;
  onCompleteActive?: () => void;
  shouldSuppressOpen: () => boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: isDragging ? "grabbing" : "grab",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <TaskCard
        task={task}
        date={date}
        areas={areas}
        variant={variant}
        onSetActive={onSetActive}
        onCompleteActive={onCompleteActive}
        shouldSuppressOpen={shouldSuppressOpen}
      />
    </div>
  );
}

function CollapsedInlineTasks({
  activeTasks,
  areas,
  date,
  hiddenCount,
  onCompleteActive,
}: {
  activeTasks: TaskDto[];
  areas: Area[];
  date: string;
  hiddenCount: number;
  onCompleteActive: () => void;
}) {
  return (
    <div className={activeTasks.length > 0 ? "space-y-2.5" : ""}>
      {activeTasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          date={date}
          areas={areas}
          variant="inline"
          onCompleteActive={onCompleteActive}
        />
      ))}
      {(hiddenCount > 0 || activeTasks.length === 0) && (
        <CollapsedTaskSummary count={hiddenCount} />
      )}
    </div>
  );
}

function Header({
  variant,
  count,
  counts,
  scope,
  areas,
  statusFilter,
  areaFilter,
  filtersActive,
  onScopeChange,
  onToggleStatus,
  onToggleArea,
  onResetFilters,
  onResetStatus,
  onResetAreas,
  onAdd,
  collapsed,
  onToggleCollapsed,
}: {
  variant: TaskListVariant;
  count: number;
  counts: Record<TaskScope, number>;
  scope: TaskScope;
  areas: Area[];
  statusFilter: TaskStatus[];
  areaFilter: AreaId[];
  filtersActive: boolean;
  onScopeChange: (scope: TaskScope) => void;
  onToggleStatus: (status: TaskStatus) => void;
  onToggleArea: (area: AreaId) => void;
  onResetFilters: () => void;
  onResetStatus: () => void;
  onResetAreas: () => void;
  onAdd: () => void;
  collapsed: boolean;
  onToggleCollapsed?: () => void;
}) {
  const countPill = (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-pill border border-border bg-background/35 px-1 text-[11px] font-medium text-muted-foreground">
      {count}
    </span>
  );
  const actions = (
    <div className="flex items-center gap-1 text-muted-foreground">
      {variant === "inline" && onToggleCollapsed && (
        <IconButton
          label={collapsed ? "Show all tasks" : "Collapse all tasks"}
          pressed={collapsed}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <ChevronsDown className="h-3.5 w-3.5" strokeWidth={1.65} />
          ) : (
            <ChevronsUp className="h-3.5 w-3.5" strokeWidth={1.65} />
          )}
        </IconButton>
      )}
      <TaskFilterPopover
        areas={areas}
        statusFilter={statusFilter}
        areaFilter={areaFilter}
        filtersActive={filtersActive}
        onToggleStatus={onToggleStatus}
        onToggleArea={onToggleArea}
        onResetFilters={onResetFilters}
        onResetStatus={onResetStatus}
        onResetAreas={onResetAreas}
      />
      <TaskScopePopover
        scope={scope}
        counts={counts}
        onScopeChange={onScopeChange}
      />
      <IconButton label="New task" onClick={onAdd}>
        <Plus className="h-3.5 w-3.5" strokeWidth={1.65} />
      </IconButton>
    </div>
  );

  // Both variants share the daybook section-header treatment (mono label ·
  // rule · right cluster) so the sidebar Tasks header reads as a sibling of
  // the Schedule header below it.
  const header = (
    <DaybookSectionHeader
      label="Tasks"
      right={
        <div className="inline-flex items-center justify-end gap-2">
          {countPill}
          {actions}
        </div>
      }
    />
  );

  // Inline (web) sits inside the content column and inherits its gutters. The
  // sidebar header is the first thing in the list panel, so it carries the
  // same px-4 gutter + top breathing room the Schedule section uses.
  if (variant === "inline") return header;
  return <div className="px-4 pt-4">{header}</div>;
}

function CollapsedTaskSummary({ count }: { count: number }) {
  return (
    <p className="px-0 py-1 text-[13px] leading-tight text-muted-foreground">
      {count === 0
        ? "No visible tasks."
        : `${count} ${count === 1 ? "task" : "tasks"} hidden.`}
    </p>
  );
}

function readInlineTasksCollapsed(): boolean {
  try {
    const stored = window.localStorage.getItem(INLINE_TASKS_COLLAPSED_STORAGE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function writeInlineTasksCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) {
      window.localStorage.setItem(INLINE_TASKS_COLLAPSED_STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(INLINE_TASKS_COLLAPSED_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts; collapsing
    // should still work for the current mounted page.
  }
}

function TaskScopePopover({
  scope,
  counts,
  onScopeChange,
}: {
  scope: TaskScope;
  counts: Record<TaskScope, number>;
  onScopeChange: (scope: TaskScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentLabel = scopeLabel(scope);

  function select(next: TaskScope) {
    onScopeChange(next);
    setOpen(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={`Task view: ${currentLabel}`}
        title={`Task view: ${currentLabel}`}
        className="inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <CalendarDays className="h-3.5 w-3.5" strokeWidth={1.65} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end">
          <Popover.Popup className="w-[150px] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
            {(["today", "week", "all"] as TaskScope[]).map((option) => {
              const selected = option === scope;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => select(option)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                    selected
                      ? "bg-foreground/[0.05] text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.035] hover:text-foreground"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {scopeLabel(option)}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground/75">
                    {counts[option]}
                  </span>
                  {selected && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                </button>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TaskFilterPopover({
  areas,
  statusFilter,
  areaFilter,
  filtersActive,
  onToggleStatus,
  onToggleArea,
  onResetFilters,
  onResetStatus,
  onResetAreas,
}: {
  areas: Area[];
  statusFilter: TaskStatus[];
  areaFilter: AreaId[];
  filtersActive: boolean;
  onToggleStatus: (status: TaskStatus) => void;
  onToggleArea: (area: AreaId) => void;
  onResetFilters: () => void;
  onResetStatus: () => void;
  onResetAreas: () => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Filter tasks"
        aria-pressed={filtersActive}
        className={`inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-foreground/[0.06] hover:text-foreground ${
          filtersActive ? "bg-foreground/[0.06] text-foreground" : ""
        }`}
      >
        <Funnel className="h-3.5 w-3.5" strokeWidth={1.65} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end">
          <Popover.Popup className="w-[260px] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg outline-none">
            <div className="flex items-center justify-between px-2 pb-2">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Filter
              </span>
              <button
                type="button"
                onClick={onResetFilters}
                className="rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
              >
                All
              </button>
            </div>

            <FilterGroup title="Status">
              <FilterRow
                label="All statuses"
                selected={statusFilter.length === STATUS_ORDER.length}
                onClick={onResetStatus}
              />
              {STATUS_ORDER.map((status) => (
                <FilterRow
                  key={status}
                  selected={statusFilter.includes(status)}
                  onClick={() => onToggleStatus(status)}
                >
                  <StatusPill status={status} />
                </FilterRow>
              ))}
            </FilterGroup>

            <FilterGroup title="Area">
              <FilterRow
                label="All areas"
                selected={areaFilter.length === 0}
                onClick={onResetAreas}
              />
              <div className="max-h-[190px] overflow-y-auto pr-1">
                {areas.map((area) => (
                  <FilterRow
                    key={area.id}
                    selected={areaFilter.includes(area.id)}
                    onClick={() => onToggleArea(area.id)}
                  >
                    <span className="truncate">{area.name}</span>
                  </FilterRow>
                ))}
              </div>
            </FilterGroup>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FilterGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border/70 py-2 first:border-t-0">
      <div className="px-2 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/75">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function FilterRow({
  label,
  selected,
  onClick,
  children,
}: {
  label?: string;
  selected: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        selected
          ? "bg-foreground/[0.05] text-foreground"
          : "text-muted-foreground hover:bg-foreground/[0.035] hover:text-foreground"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{children ?? label}</span>
      {selected && (
        <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function SectionHeader({
  status,
  count,
}: {
  status: TaskStatus;
  count: number;
}) {
  const label = STATUS_STYLES[status].section;
  return (
    <div className="mb-3 flex items-center gap-3 px-2">
      <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </h3>
      <div className="h-px flex-1 bg-border" />
      <span className="font-mono text-[11px] font-semibold tabular-nums text-muted-foreground">
        {String(count).padStart(2, "0")}
      </span>
    </div>
  );
}

function NewTaskCard({
  onSubmit,
  onCancel,
}: {
  onSubmit: (content: string, area: AreaId) => void;
  onCancel: () => void;
}) {
  const { data: liveAreas } = useAreas();
  const areas = liveAreas ?? defaultAreas;

  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<"typing" | "picking" | "creating-area">("typing");
  const [pickerCursor, setPickerCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Listbox length includes the "+ New area" row at the end.
  const listLength = areas.length + 1;

  useEffect(() => {
    if (phase === "typing") {
      inputRef.current?.focus();
    } else if (phase === "picking") {
      pickerRef.current?.focus();
    }
  }, [phase]);

  function advanceToPicker() {
    if (!value.trim()) {
      onCancel();
      return;
    }
    setPhase("picking");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      advanceToPicker();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  function onPickerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Halt propagation so global type-anywhere shortcuts don't double-fire
    // while the picker has focus.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setPickerCursor((c) => (c + 1) % listLength);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setPickerCursor((c) => (c - 1 + listLength) % listLength);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (pickerCursor === areas.length) {
        setPhase("creating-area");
      } else {
        onSubmit(value, areas[pickerCursor].id);
      }
      return;
    }
    // 1-9 numeric shortcut: maps to the Nth area in the live list.
    const num = parseInt(e.key, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= areas.length) {
      e.preventDefault();
      e.stopPropagation();
      onSubmit(value, areas[num - 1].id);
      return;
    }
    // Any other printable character: swallow so the palette typeahead
    // doesn't open mid-pick (the user can press Esc to cancel and retype).
    if (e.key.length === 1) {
      e.stopPropagation();
    }
  }

  return (
    <div className="rounded-lg border border-border/50 bg-background/70 dark:bg-foreground/[0.04] p-3">
      <div className="flex items-start gap-2">
        <FileText
          className="h-3.5 w-3.5 mt-[3px] text-muted-foreground shrink-0"
          strokeWidth={1.5}
        />
        {phase === "typing" ? (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="What needs to be done?"
            className="flex-1 bg-transparent outline-none text-[13.5px] leading-snug font-medium placeholder:text-muted-foreground/60 min-w-0"
          />
        ) : phase === "creating-area" ? (
          <div className="flex-1 min-w-0">
            <p className="text-[13.5px] leading-snug font-medium text-foreground truncate mb-2">
              {value}
            </p>
            <NewAreaForm
              compact
              onCreated={(s) => onSubmit(value, s.id)}
              onCancel={() => setPhase("picking")}
            />
          </div>
        ) : (
          <div className="flex-1 min-w-0 space-y-2">
            <p className="text-[13.5px] leading-snug font-medium text-foreground truncate">
              {value}
            </p>
            <div
              ref={pickerRef}
              tabIndex={-1}
              onKeyDown={onPickerKeyDown}
              role="listbox"
              aria-label="Pick a area"
              className="space-y-0.5 outline-none"
            >
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/80 mb-1">
                Send to
              </p>
              {areas.map((s, i) => {
                const isCursor = i === pickerCursor;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={isCursor}
                    onClick={() => onSubmit(value, s.id)}
                    onMouseEnter={() => setPickerCursor(i)}
                    className={`w-full flex items-center gap-2 px-1.5 py-1 rounded text-[12.5px] text-left transition-colors ${
                      isCursor
                        ? "bg-foreground/[0.06]"
                        : "hover:bg-foreground/[0.03]"
                    }`}
                  >
                    <span className="flex-1 truncate">{s.name}</span>
                    <kbd className="text-[10px] font-mono text-muted-foreground/70 shrink-0">
                      {i + 1}
                    </kbd>
                  </button>
                );
              })}
              <button
                type="button"
                role="option"
                aria-selected={pickerCursor === areas.length}
                onClick={() => setPhase("creating-area")}
                onMouseEnter={() => setPickerCursor(areas.length)}
                className={`w-full flex items-center gap-2 px-1.5 py-1 rounded text-[12.5px] text-left text-muted-foreground transition-colors ${
                  pickerCursor === areas.length
                    ? "bg-foreground/[0.06]"
                    : "hover:bg-foreground/[0.03]"
                }`}
              >
                <span className="flex-1 truncate">+ New area</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function IconButton({
  children,
  label,
  pressed,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  pressed?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={`inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-foreground/[0.06] hover:text-foreground ${
        pressed ? "bg-foreground/[0.06] text-foreground" : ""
      }`}
    >
      {children}
    </button>
  );
}

function TaskCard({
  task,
  date,
  areas,
  variant,
  onSetActive,
  onCompleteActive,
  shouldSuppressOpen,
}: {
  task: TaskDto;
  date: string;
  areas: Area[];
  variant: TaskListVariant;
  onSetActive?: () => void;
  onCompleteActive?: () => void;
  shouldSuppressOpen?: () => boolean;
}) {
  const navigate = useNavigate();
  const { openInNewTab } = useTabs();
  const { addPage } = useRightSidebar();
  const { update, pauseTimer, resumeTimer } = useTaskMutations();
  const [statusOpen, setStatusOpen] = useState(false);
  const openPointerIntentRef = useRef<TaskOpenPointerIntent | null>(null);
  const openPointerCleanupRef = useRef<(() => void) | null>(null);
  const isDone = task.status === "done";
  const isFramed = task.status === "in-progress";
  const isTimerRunning = task.status === "in-progress" && !!task.inProgressStartedAt;
  const isTimerPaused = task.status === "in-progress" && !task.inProgressStartedAt;
  const areaName = getAreaName(task.area, areas);
  const statusLabel = isTimerPaused ? "Paused" : STATUS_STYLES[task.status].label;

  useEffect(() => () => openPointerCleanupRef.current?.(), []);

  function handleOpenPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;

    openPointerCleanupRef.current?.();

    const intent: TaskOpenPointerIntent = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    openPointerIntentRef.current = intent;

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== intent.pointerId) return;
      const dx = event.clientX - intent.startX;
      const dy = event.clientY - intent.startY;
      if (dx * dx + dy * dy > 16) {
        intent.moved = true;
      }
    };
    const onEnd = (event: PointerEvent) => {
      if (event.pointerId === intent.pointerId) removeListeners();
    };
    const removeListeners = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (openPointerCleanupRef.current === removeListeners) {
        openPointerCleanupRef.current = null;
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onEnd, { passive: true });
    window.addEventListener("pointercancel", onEnd, { passive: true });
    openPointerCleanupRef.current = removeListeners;
  }

  function handleOpenClick(e: React.MouseEvent<HTMLButtonElement>) {
    const moved = openPointerIntentRef.current?.moved ?? false;
    const suppressed = shouldSuppressOpen?.() ?? false;
    openPointerIntentRef.current = null;
    openPointerCleanupRef.current?.();

    if (moved || suppressed) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // The card is a <button> (not an <a href>), so the document-level link
    // handlers never see it. Mirror the app-wide link convention here:
    // Shift opens references; Shift+Cmd/Ctrl opens a new tab.
    if (e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      // Drop focus before switching tabs: the sidebar is a persistent layout
      // panel, so a focus ring left on this card would still be showing when
      // the user returns to this tab.
      e.currentTarget.blur();
      const href = `/cadence/${date}/task/${task.id}`;
      if (e.metaKey || e.ctrlKey) {
        openInNewTab(href);
      } else {
        addPage({ href, title: task.content });
      }
      return;
    }

    void navigate({
      to: "/cadence/$date/task/$id",
      params: { date, id: task.id },
    });
  }

  function changeStatus(s: TaskStatus) {
    setStatusOpen(false);
    update.mutate({ id: task.id, update: { status: s } });
    if (s === "in-progress") {
      onSetActive?.();
    } else if (task.status === "in-progress" && s === "done") {
      onCompleteActive?.();
    }
  }

  function changeDate(next: string) {
    if (next === task.scheduled) return;
    update.mutate({ id: task.id, update: { scheduled: next } });
  }

  function changeArea(next: AreaId) {
    if (next === task.area) return;
    update.mutate({ id: task.id, update: { area: next } });
  }

  function toggleDone() {
    const nextStatus = isDone ? "backlog" : "done";
    update.mutate({
      id: task.id,
      update: { status: nextStatus },
    });
    if (task.status === "in-progress" && nextStatus === "done") {
      onCompleteActive?.();
    }
  }

  function pauseActiveTimer() {
    pauseTimer.mutate({ id: task.id });
  }

  function resumeActiveTimer() {
    resumeTimer.mutate({ id: task.id });
  }

  const ariaLabel = `Open task: ${stripWikilinks(task.content)}`;
  const taskLabel = stripWikilinks(task.content);

  if (variant === "sidebar") {
    return (
      <article
        data-task-timer-state={
          task.status === "in-progress"
            ? isTimerRunning
              ? "running"
              : "paused"
            : undefined
        }
        className={`group/row relative overflow-hidden rounded-lg transition-colors ${
          isFramed
            ? `bg-content/70 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_18px_-12px_rgb(0_0_0/0.14)] ring-1 ${
                isTimerPaused
                  ? "ring-sky-400/40 dark:ring-sky-300/35"
                  : "ring-[#4E9A73]/40 dark:ring-[#4E9A73]/45"
              }`
            : "hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06]"
        }`}
      >
        <button
          type="button"
          aria-label={ariaLabel}
          onPointerDown={handleOpenPointerDown}
          onClick={handleOpenClick}
          className="absolute inset-0 rounded-lg border-0 bg-transparent p-0"
        />
        <div className="relative pointer-events-none flex gap-2.5 px-2.5 py-1.5">
          {/* Status circle doubles as the status-change trigger — the same
              3-state popover the meta dropdown used to open. */}
          <Popover.Root open={statusOpen} onOpenChange={setStatusOpen}>
            <Popover.Trigger
              aria-label={`Change status (currently ${statusLabel})`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              className="group/status pointer-events-auto mt-px block shrink-0 rounded-full outline-none"
            >
              <StatusCircle status={task.status} paused={isTimerPaused} />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner sideOffset={4} align="start">
                <Popover.Popup
                  data-task-popover
                  className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-1 min-w-[160px]"
                >
                  {STATUS_ORDER.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        changeStatus(s);
                      }}
                      className="w-full text-left px-2 py-1.5 rounded text-sm hover:bg-foreground/[0.05] transition-colors flex items-center gap-2"
                    >
                      <StatusPill status={s} />
                      {s === task.status && (
                        <span className="ml-auto text-muted-foreground">✓</span>
                      )}
                    </button>
                  ))}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
          <div className="min-w-0 flex-1">
            <div
              title={taskLabel}
              className={`line-clamp-2 text-[13px] font-medium leading-[1.3] ${
                isDone
                  ? "text-muted-foreground/60 line-through"
                  : "text-foreground"
              }`}
            >
              <RichText text={task.content} noLink />
            </div>
            <div className="mt-[2px] -ml-1 flex min-h-4 min-w-0 items-center gap-1.5 overflow-hidden font-mono text-[11px] leading-none text-muted-foreground/75">
              {isFramed && (
                <ActiveTimerButton
                  running={isTimerRunning}
                  taskLabel={taskLabel}
                  onPause={pauseActiveTimer}
                  onResume={resumeActiveTimer}
                />
              )}
              {areaName && (
                <CardAreaField
                  area={task.area}
                  areas={areas}
                  onPick={changeArea}
                />
              )}
              {isFramed && <CardTimeSpent task={task} />}
              {/* Status lives in the left circle now. Backlog/done rows reveal a
                  date control on hover/focus for quick rescheduling; active rows
                  show the timer chrome instead.
                  has-[data-popup-open] keeps the zone open while a dropdown is. */}
              {!isFramed && (
                <span className="hidden shrink-0 items-center gap-1.5 group-hover/row:flex group-focus-within/row:flex has-[[data-popup-open]]:flex">
                  {areaName && (
                    <span aria-hidden className="text-muted-foreground/35">
                      •
                    </span>
                  )}
                  <CardDateField date={task.scheduled} onPick={changeDate} />
                </span>
              )}
            </div>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article
      data-task-timer-state={
        task.status === "in-progress"
          ? isTimerRunning
            ? "running"
            : "paused"
          : undefined
      }
      className={`relative overflow-hidden ${variant === "inline" ? "-mx-2.5" : ""} ${
        isFramed
          ? `rounded-[10px] border border-border bg-content/80 ${
              isTimerPaused
                ? "border-sky-400/20 shadow-[0_0_0_1px_hsl(208_82%_55%/0.12),0_10px_24px_-22px_hsl(212_88%_48%/0.52)] dark:border-sky-300/18 dark:shadow-[0_0_0_1px_hsl(205_90%_70%/0.16),0_10px_24px_-22px_hsl(205_88%_62%/0.38)]"
                : ""
            }`
          : "rounded-md dark:bg-foreground/[0.025]"
      }`}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        onPointerDown={handleOpenPointerDown}
        onClick={handleOpenClick}
        className={`absolute inset-0 border-0 bg-transparent p-0 transition-colors ${
          isFramed
            ? "rounded-[10px] hover:bg-foreground/[0.025]"
            : "rounded-md hover:bg-foreground/[0.025] dark:hover:bg-transparent"
        }`}
      />
      <div
        className={`relative pointer-events-none ${
          isFramed ? "p-2.5" : "px-2.5 py-2"
        }`}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          {variant === "inline" && (
            <TaskDoneCheckbox
              checked={isDone}
              label={`${isDone ? "Mark task not done" : "Mark task done"}: ${taskLabel}`}
              onToggle={toggleDone}
            />
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <div
              title={taskLabel}
              className={`line-clamp-2 text-[14px] font-medium leading-[1.25] tracking-normal ${
                isDone ? "line-through text-muted-foreground" : "text-foreground"
              }`}
            >
              <RichText text={task.content} noLink />
            </div>
            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-[12px] leading-none text-muted-foreground">
              <Popover.Root open={statusOpen} onOpenChange={setStatusOpen}>
                <Popover.Trigger
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  className="pointer-events-auto inline-flex shrink-0 rounded-md transition-opacity hover:opacity-80"
                >
                  <StatusPill status={task.status} paused={isTimerPaused} />
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner sideOffset={4} align="start">
                    <Popover.Popup className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-1 min-w-[160px]">
                      {STATUS_ORDER.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            changeStatus(s);
                          }}
                          className="w-full text-left px-2 py-1.5 rounded text-sm hover:bg-foreground/[0.05] transition-colors flex items-center gap-2"
                        >
                          <StatusPill status={s} />
                          {s === task.status && (
                            <span className="ml-auto text-muted-foreground">✓</span>
                          )}
                        </button>
                      ))}
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
              {task.status === "in-progress" && (
                <ActiveTimerButton
                  running={isTimerRunning}
                  taskLabel={taskLabel}
                  onPause={pauseActiveTimer}
                  onResume={resumeActiveTimer}
                />
              )}
              {task.scheduled && !isFramed && (
                <CardDateField date={task.scheduled} onPick={changeDate} />
              )}
              <span aria-hidden className="shrink-0 text-muted-foreground/70">
                /
              </span>
              <span className="min-w-0 truncate">{areaName}</span>
              {isFramed && <CardTimeSpent task={task} />}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function TaskDoneCheckbox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={`pointer-events-auto mt-[1px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
        checked
          ? "border-foreground/75 bg-foreground text-background"
          : "border-muted-foreground/40 bg-background/45 text-transparent hover:border-muted-foreground/70 hover:bg-foreground/[0.025]"
      }`}
    >
      <Check className="h-3 w-3" strokeWidth={2.4} />
    </button>
  );
}

function CardTimeSpent({ task }: { task: TaskDto }) {
  const isLive = task.status === "in-progress" && !!task.inProgressStartedAt;
  const now = useDisplayNow(isLive ? 1000 : null);

  const seconds = liveTimeSpent(
    task.timeSpentSeconds,
    task.inProgressStartedAt,
    now,
  );

  return (
    <span
      aria-label={`Time spent: ${formatDuration(seconds)}`}
      className="ml-0.5 inline-flex shrink-0 items-center gap-2 text-muted-foreground/70"
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 translate-y-px rounded-full bg-blue-500 ${isLive ? "animate-pulse" : ""}`}
      />
      {formatDuration(seconds)}
    </span>
  );
}

function ActiveTimerButton({
  running,
  taskLabel,
  onPause,
  onResume,
}: {
  running: boolean;
  taskLabel: string;
  onPause: () => void;
  onResume: () => void;
}) {
  const label = running ? `Pause timer: ${taskLabel}` : `Resume timer: ${taskLabel}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={running ? "Pause timer" : "Resume timer"}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (running) {
          onPause();
        } else {
          onResume();
        }
      }}
      className="pointer-events-auto inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
    >
      {running ? (
        <Pause className="h-3 w-3" strokeWidth={2} />
      ) : (
        <Play className="h-3 w-3" strokeWidth={2} />
      )}
    </button>
  );
}

// Close an open row popover when the pointer moves off the tasks panel without
// a selection. The popups are portaled to <body>, so a plain mouse-leave would
// fire the moment the cursor enters the popup. Instead we keep the popover open
// while the pointer is over the panel ([data-task-sidebar]) or the popup itself
// ([data-task-popover]) and close on the first pointerover anywhere else.
function useCloseOnPointerLeaveSidebar(
  open: boolean,
  setOpen: (next: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;
    const handlePointerOver = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest("[data-task-sidebar]") ||
        target?.closest("[data-task-popover]")
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerover", handlePointerOver);
    return () =>
      document.removeEventListener("pointerover", handlePointerOver);
  }, [open, setOpen]);
}

function CardDateField({
  date,
  onPick,
}: {
  date?: string;
  onPick: (next: string) => void;
}) {
  const today = useToday();
  const [open, setOpen] = useState(false);
  useCloseOnPointerLeaveSidebar(open, setOpen);
  const [viewMonth, setViewMonth] = useState(() => monthStart(date || today));

  useEffect(() => {
    if (!open) setViewMonth(monthStart(date || today));
  }, [date, open, today]);

  function pick(next: string) {
    setOpen(false);
    onPick(next);
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={
          date
            ? `Reschedule task (currently ${formatShortDate(date)})`
            : "Schedule task"
        }
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className="pointer-events-auto inline-flex shrink-0 items-center rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <CalendarDays className="h-3 w-3" strokeWidth={1.6} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="end">
          <Popover.Popup
            data-task-popover
            onClick={(e) => e.stopPropagation()}
            className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-3 w-[280px]"
          >
            <CalendarGrid
              viewMonth={viewMonth}
              selected={date ?? ""}
              today={today}
              onPrev={() => setViewMonth(addMonths(viewMonth, -1))}
              onNext={() => setViewMonth(addMonths(viewMonth, 1))}
              onPick={pick}
              onJumpToday={() => pick(today)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Inline area picker for a sidebar task row — click the area label to reassign
// the task without opening it. Mirrors the status popover's styling.
function CardAreaField({
  area,
  areas,
  onPick,
}: {
  area: AreaId;
  areas: Area[];
  onPick: (next: AreaId) => void;
}) {
  const [open, setOpen] = useState(false);
  useCloseOnPointerLeaveSidebar(open, setOpen);
  const areaName = getAreaName(area, areas);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={`Change area (currently ${areaName})`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className="pointer-events-auto inline-flex min-w-0 items-center rounded px-1 py-0.5 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <span className="truncate">{areaName}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start">
          <Popover.Popup
            data-task-popover
            className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-1 min-w-[160px] max-h-[280px] overflow-y-auto"
          >
            {areas.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                  onPick(a.id);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-foreground/[0.05]"
              >
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: a.color }}
                />
                <span className="flex-1 truncate">{a.name}</span>
                {a.id === area && (
                  <span className="ml-auto shrink-0 text-muted-foreground">✓</span>
                )}
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function stripWikilinks(text: string): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, "$1");
}

const STATUS_STYLES: Record<
  TaskStatus,
  { dot: string; fill: string; border: string; text: string; label: string; section: string }
> = {
  backlog: {
    dot: "bg-muted-foreground/45",
    fill: "bg-background/35",
    border: "border border-border",
    text: "text-muted-foreground",
    label: "Backlog",
    section: "Backlog",
  },
  "in-progress": {
    dot: "bg-[#4E9A73]",
    fill: "bg-[#4E9A73]/10",
    border: "border border-[#4E9A73]/25",
    text: "text-[#2F6E4F] dark:text-[#7AC89D]",
    label: "Active",
    section: "Active",
  },
  done: {
    dot: "bg-foreground/50",
    fill: "bg-background/35",
    border: "border border-border",
    text: "text-muted-foreground",
    label: "Done",
    section: "Done",
  },
};

export function StatusPill({
  status,
  paused = false,
  size = "sm",
}: {
  status: TaskStatus;
  paused?: boolean;
  size?: "sm" | "md";
}) {
  const s = STATUS_STYLES[status];
  const isPaused = paused && status === "in-progress";
  const fill = isPaused ? "bg-sky-400/[0.08] dark:bg-sky-300/[0.07]" : s.fill;
  const text = isPaused
    ? "text-sky-700/75 opacity-80 dark:text-sky-200/75"
    : s.text;
  const border = isPaused
    ? "border border-sky-500/24 dark:border-sky-300/24"
    : s.border;
  const dot = isPaused ? "bg-sky-500/75" : s.dot;
  const label = isPaused ? "Paused" : s.label;
  // Backlog/Done use a near-transparent fill, so even the md pill (task detail
  // page) keeps its border for definition — matching the bordered pill in the
  // status dropdown. The colored Active/Paused fills read on their own, so they
  // stay borderless to sit flush with the flat Area pill below. The sm pill
  // (cards, status menus) always keeps its border. (border-box → no size change.)
  const neutral = status === "backlog" || status === "done";
  const sizing =
    size === "md"
      ? `h-7 gap-1.5 px-2 rounded-md text-[13px] leading-none ${fill} ${text}${
          neutral ? ` ${border}` : ""
        }`
      : `gap-1.5 px-1.5 py-0.5 rounded-md text-[12px] ${fill} ${text} ${border}`;
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap font-mono font-medium ${sizing}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

// A Linear-style status glyph used as the left rail of each sidebar task row.
// The status is already labelled by the section header, so the row only needs
// a compact, scannable indicator that doubles as the status-change trigger.
function StatusCircle({
  status,
  paused = false,
}: {
  status: TaskStatus;
  paused?: boolean;
}) {
  if (status === "done") {
    return (
      <span className="flex h-[15px] w-[15px] items-center justify-center rounded-full border-[1.5px] border-muted-foreground/30 text-muted-foreground/55 transition-colors group-hover/status:border-muted-foreground/55">
        <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === "in-progress") {
    const ring = paused
      ? "border-sky-500/80 dark:border-sky-300/80"
      : "border-[#4E9A73]";
    const fill = paused ? "bg-sky-500/80 dark:bg-sky-300/80" : "bg-[#4E9A73]";
    return (
      <span
        className={`flex h-[15px] w-[15px] items-center justify-center rounded-full border-2 ${ring}`}
      >
        <span className={`h-[5px] w-[5px] rounded-full ${fill}`} />
      </span>
    );
  }
  return (
    <span className="block h-[15px] w-[15px] rounded-full border-[1.5px] border-muted-foreground/35 transition-colors group-hover/status:border-foreground/55" />
  );
}

export function SpaceLabel({
  area,
  size = "sm",
}: {
  area: AreaId;
  size?: "sm" | "md";
}) {
  const { data: areas } = useAreas();
  const sizing =
    size === "md"
      ? "h-7 px-2 rounded-md text-[13px] leading-none"
      : "px-1.5 py-0.5 rounded text-[11px]";
  const name = getAreaName(area, areas);
  return (
    <span
      className={`inline-flex items-center font-medium ${sizing} bg-foreground/[0.06] text-foreground/80`}
    >
      {name}
    </span>
  );
}

function sortTasksForSection(tasks: TaskDto[]): TaskDto[] {
  return [...tasks].sort((a, b) => {
    const dateCompare = (a.scheduled ?? "").localeCompare(b.scheduled ?? "");
    if (dateCompare !== 0) return dateCompare;
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    return a.content.localeCompare(b.content);
  });
}

function isTaskInWeek(task: TaskDto, anchorDate: string): boolean {
  if (!task.scheduled) return false;
  const anchor = parseLocalDate(anchorDate);
  const day = anchor.getDay();
  const start = new Date(anchor);
  start.setDate(anchor.getDate() - day);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 7);

  const scheduled = parseLocalDate(task.scheduled);
  return scheduled >= start && scheduled < end;
}

function parseLocalDate(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00");
}

function emptyTaskMessage(
  scope: TaskScope,
  date: string,
  filtersActive: boolean,
  variant: TaskListVariant,
): string {
  if (filtersActive) return "No tasks match these filters.";
  if (variant === "inline" && scope === "today") return "No tasks.";
  if (scope === "today") return `No tasks for ${formatLongDate(date)}.`;
  if (scope === "week") return "No tasks this week.";
  return "No tasks.";
}


function scopeLabel(scope: TaskScope): string {
  if (scope === "today") return "Today";
  if (scope === "week") return "Week";
  return "All";
}

/** @deprecated Import from `@/lib/cadence/sidebar-date` instead. */
export { extractDate } from "@/lib/cadence/sidebar-date";

function formatLongDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
