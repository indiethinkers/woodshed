import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Popover } from "@base-ui/react/popover";
import {
  Calendar as CalendarIcon,
  ChevronDown,
  CircleDashed,
  Clock,
  Hash,
  Layers,
  type LucideIcon,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import { AreaId, TaskStatus } from "@/lib/types";
import { BacklinksPanel } from "@/components/shared/backlinks-panel";
import { FilePathLine } from "@/components/shared/file-path-pill";
import { OutgoingLinksPanel } from "@/components/shared/outgoing-links-panel";
import { TagEditor } from "@/components/shared/tag-editor";
import { RichText } from "@/components/shared/rich-text";
import { TiptapEditor } from "@/components/shared/tiptap-editor";
import { defaultAreas } from "@/lib/areas";
import { formatDuration, liveTimeSpent } from "@/lib/format-duration";
import { StatusPill, SpaceLabel } from "./task-sidebar";
import {
  CalendarGrid,
} from "./date-picker";
import { addMonths, monthStart } from "./date-utils";
import { useToday } from "@/lib/hooks/use-today";
import { NewAreaForm } from "@/components/areas/new-area-form";
import {
  useTask,
  useTaskMutations,
  type TaskDto,
} from "@/lib/hooks/use-tasks";
import { useAreas } from "@/lib/hooks/use-areas";

interface TaskEditorProps {
  id: string;
  date: string;
}

const STATUS_ORDER: TaskStatus[] = ["backlog", "in-progress", "done"];

export function TaskEditor({ id, date }: TaskEditorProps) {
  const { data: task, isLoading, error } = useTask(id);

  if (isLoading) {
    return <TaskSkeleton />;
  }
  if (error) {
    // The query threw — usually a Rust-side parse / IO failure surfaced
    // through `tauriInvoke`. Show the underlying message so the user can
    // copy it into a bug report instead of staring at a generic
    // "not found" that's actually a load error.
    return (
      <article className="w-full">
        <p className="text-sm text-foreground mb-2">Couldn't open this task.</p>
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-words bg-muted/50 rounded p-2">
          {error instanceof Error ? error.message : String(error)}
        </pre>
      </article>
    );
  }
  if (!task) {
    return (
      <article className="w-full">
        <p className="text-sm text-muted-foreground">Task not found.</p>
      </article>
    );
  }
  return <TaskEditorInner task={task} date={date} />;
}

function TaskSkeleton() {
  return (
    <article className="w-full animate-pulse">
      <div className="h-7 w-16 bg-muted rounded mb-6" />
      <div className="h-7 w-3/4 bg-muted rounded mb-6" />
      <div className="space-y-3">
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-2/3 bg-muted rounded" />
      </div>
    </article>
  );
}

function TaskEditorInner({ task, date }: { task: TaskDto; date: string }) {
  const navigate = useNavigate();
  const { update, remove, pauseTimer, resumeTimer } = useTaskMutations();

  // An in-progress task whose timer isn't currently running is "paused" —
  // distinct from the green "Active" running state. Mirrors the sidebar
  // cards (isTimerPaused) so the detail page tells the same story.
  const isTimerRunning =
    task.status === "in-progress" && !!task.inProgressStartedAt;
  const isTimerPaused =
    task.status === "in-progress" && !task.inProgressStartedAt;

  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.content);
  const [statusOpen, setStatusOpen] = useState(false);
  const [spaceOpen, setAreaOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Sync drafts when external file changes flow through TanStack — but only
  // when the user isn't actively editing that field.
  useEffect(() => {
    if (!titleEditing) setTitleDraft(task.content);
  }, [task.content, titleEditing]);

  function commitTitle() {
    const next = titleDraft.trim();
    setTitleEditing(false);
    if (!next || next === task.content) {
      setTitleDraft(task.content);
      return;
    }
    update.mutate({ id: task.id, update: { content: next } });
  }

  function commitBody(next: string) {
    if (next === task.body) return;
    update.mutate({ id: task.id, update: { body: next } });
  }

  function changeStatus(s: TaskStatus) {
    setStatusOpen(false);
    if (s === task.status) return;
    update.mutate({ id: task.id, update: { status: s } });
  }

  function changeArea(s: AreaId) {
    setAreaOpen(false);
    if (s === task.area) return;
    update.mutate({ id: task.id, update: { area: s } });
  }

  function changeDate(next: string) {
    if (next === date) return;
    update.mutate({ id: task.id, update: { scheduled: next } });
    void navigate({
      replace: true,
      to: "/cadence/$date/task/$id",
      params: { date: next, id: task.id },
    });
  }

  function handleDelete() {
    if (!deleting) {
      setDeleting(true);
      return;
    }
    remove.mutate(
      { id: task.id },
      {
        onSuccess: () =>
          void navigate({ replace: true, to: "/cadence/$date", params: { date } }),
      },
    );
  }

  return (
    <article className="w-full">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <TitleField
            value={titleDraft}
            editing={titleEditing}
            rendered={task.content}
            onChange={setTitleDraft}
            onStartEdit={() => setTitleEditing(true)}
            onCommit={commitTitle}
          />
          <FilePathLine className="mt-1.5" />
        </div>
        <DeleteButton
          deleting={deleting}
          onDelete={handleDelete}
          onCancel={() => setDeleting(false)}
        />
      </header>

      <dl className="grid grid-cols-[180px_1fr] gap-y-1.5 text-[15px] mb-8">
        <PropertyLabel icon={CircleDashed} label="Status" />
        <dd className="self-center">
          <Popover.Root open={statusOpen} onOpenChange={setStatusOpen}>
            <Popover.Trigger className="inline-flex items-center gap-1.5 px-1.5 py-1 -ml-1.5 rounded hover:bg-foreground/[0.05] transition-colors">
              <StatusPill status={task.status} paused={isTimerPaused} size="md" />
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner sideOffset={4} align="start">
                <Popover.Popup className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-1 min-w-[160px]">
                  {STATUS_ORDER.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => changeStatus(s)}
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
        </dd>

        <PropertyLabel icon={Layers} label="Area" />
        <dd className="self-center">
          <Popover.Root open={spaceOpen} onOpenChange={setAreaOpen}>
            <Popover.Trigger className="inline-flex items-center gap-1.5 px-1.5 py-1 -ml-1.5 rounded hover:bg-foreground/[0.05] transition-colors">
              <SpaceLabel area={task.area} size="md" />
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner sideOffset={4} align="start">
                <Popover.Popup className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-1 min-w-[200px]">
                  <SpacePopupContent
                    activeArea={task.area}
                    onPick={(id) => {
                      setAreaOpen(false);
                      changeArea(id);
                    }}
                  />
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        </dd>

        <PropertyLabel icon={CalendarIcon} label="Date" />
        <dd className="self-center">
          <DateField date={date} onPick={changeDate} />
        </dd>

        {(task.timeSpentSeconds > 0 || task.status === "in-progress") && (
          <>
            <PropertyLabel icon={Clock} label="Time spent" />
            <dd className="self-center px-1.5 py-1 -ml-1.5">
              <div className="inline-flex items-center gap-3">
                <TimeSpent task={task} />
                {task.status === "in-progress" && (
                  <TimerToggle
                    running={isTimerRunning}
                    onToggle={() =>
                      isTimerRunning
                        ? pauseTimer.mutate({ id: task.id })
                        : resumeTimer.mutate({ id: task.id })
                    }
                  />
                )}
              </div>
            </dd>
          </>
        )}

        <PropertyLabel icon={Hash} label="Tags" />
        <dd className="self-center px-1.5 py-1 -ml-1.5">
          <TagEditor
            tags={task.tags}
            lockedTags={["task"]}
            onCommit={(next) =>
              update.mutate({ id: task.id, update: { tags: next } })
            }
          />
        </dd>
      </dl>

      <div className="border-t border-border pt-6">
        <h2 className="text-sm font-medium text-muted-foreground mb-2">Notes</h2>
        <TiptapEditor
          value={task.body}
          onCommit={commitBody}
          unwrapOutlineOnLoad
          placeholder="Start writing..."
          className="text-[15px] leading-normal min-h-[120px]"
        />
      </div>

      <OutgoingLinksPanel sourceId={task.id} />
      <BacklinksPanel targetId={task.id} />
    </article>
  );
}

function PropertyLabel({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <dt className="self-center -ml-1.5 inline-flex items-center gap-2 text-muted-foreground px-1.5 py-1.5">
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </dt>
  );
}

function SpacePopupContent({
  activeArea,
  onPick,
}: {
  activeArea: AreaId;
  onPick: (id: AreaId) => void;
}) {
  const { data: liveAreas } = useAreas();
  const areas = liveAreas ?? defaultAreas;
  const [creating, setCreating] = useState(false);

  if (creating) {
    return (
      <div className="p-2">
        <NewAreaForm
          compact
          onCreated={(s) => onPick(s.id)}
          onCancel={() => setCreating(false)}
        />
      </div>
    );
  }

  return (
    <>
      {areas.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onPick(s.id)}
          className="w-full text-left px-2 py-1.5 rounded text-sm hover:bg-foreground/[0.05] transition-colors flex items-center gap-2"
        >
          <SpaceLabel area={s.id} />
          {s.id === activeArea && (
            <span className="ml-auto text-muted-foreground">✓</span>
          )}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="w-full text-left px-2 py-1.5 rounded text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors"
      >
        + New area
      </button>
    </>
  );
}

function DateField({
  date,
  onPick,
}: {
  date: string;
  onPick: (next: string) => void;
}) {
  const today = useToday();
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => monthStart(date));

  useEffect(() => {
    if (!open) setViewMonth(monthStart(date));
  }, [date, open]);

  function pick(next: string) {
    setOpen(false);
    onPick(next);
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="inline-flex items-center gap-1.5 px-1.5 py-1 -ml-1.5 rounded text-foreground hover:bg-foreground/[0.05] transition-colors">
        {formatLongDate(date)}
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start">
          <Popover.Popup className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-3 w-[280px]">
            <CalendarGrid
              viewMonth={viewMonth}
              selected={date}
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

function TimeSpent({ task }: { task: TaskDto }) {
  const isLive = task.status === "in-progress" && !!task.inProgressStartedAt;
  // Re-render every second while a run is active so the ticker advances.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!isLive) return;
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, [isLive]);
  const seconds = liveTimeSpent(
    task.timeSpentSeconds,
    task.inProgressStartedAt,
    now,
  );
  return (
    <span className="font-mono text-sm text-foreground inline-flex items-center gap-2">
      {formatDuration(seconds)}
      {isLive && (
        <span
          aria-label="active timer"
          className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse"
        />
      )}
    </span>
  );
}

// Timer state toggle for the detail page's Time-spent row. The TEXT names the
// current state ("Running" / "Paused") so the page reads the state plainly;
// the icon names the action the click performs (pause while running, resume
// while paused). The paused state borrows the sky accent the StatusPill uses.
function TimerToggle({
  running,
  onToggle,
}: {
  running: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={running ? "Pause timer" : "Resume timer"}
      title={running ? "Pause timer" : "Resume timer"}
      className={`inline-flex items-center gap-1.5 rounded px-1.5 py-1 -my-1 text-[13px] transition-colors hover:bg-foreground/[0.05] ${
        running
          ? "text-muted-foreground hover:text-foreground"
          : "text-sky-600/90 hover:text-sky-700 dark:text-sky-300/90 dark:hover:text-sky-200"
      }`}
    >
      {running ? (
        <Pause className="h-3.5 w-3.5" strokeWidth={2} />
      ) : (
        <Play className="h-3.5 w-3.5" strokeWidth={2} />
      )}
      {running ? "Running" : "Paused"}
    </button>
  );
}

function TitleField({
  value,
  editing,
  rendered,
  onChange,
  onStartEdit,
  onCommit,
}: {
  value: string;
  editing: boolean;
  rendered: string;
  onChange: (v: string) => void;
  onStartEdit: () => void;
  onCommit: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [editing]);

  if (editing) {
    return (
      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        onChange={(e) => {
          onChange(e.target.value);
          e.currentTarget.style.height = "auto";
          e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
        }}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            onCommit();
          }
        }}
        // `block w-full`, not `flex-1`: the parent is a plain block, so
        // flex-1 is inert and the textarea would fall back to its intrinsic
        // `cols` width (~20ch) — wrapping the title at a phantom boundary
        // long before the real edge of the column.
        className="block w-full text-2xl font-semibold tracking-[-0.02em] leading-tight bg-transparent outline-none focus:outline-none resize-none overflow-hidden"
      />
    );
  }
  return (
    <h1
      className="flex-1 min-w-0 text-2xl font-semibold tracking-[-0.02em] leading-tight cursor-text rounded -mx-1 px-1 hover:bg-foreground/[0.03] transition-colors"
      onClick={onStartEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onStartEdit();
        }
      }}
    >
      <RichText text={rendered} />
    </h1>
  );
}

function DeleteButton({
  deleting,
  onDelete,
  onCancel,
}: {
  deleting: boolean;
  onDelete: () => void;
  onCancel: () => void;
}) {
  if (deleting) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground">Delete this task?</span>
        <button
          type="button"
          onClick={onDelete}
          className="h-7 px-3 rounded-sm bg-accent text-accent-foreground text-[13px]"
        >
          Yes, delete
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-3 rounded-sm border border-border text-[13px] text-foreground hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onDelete}
      aria-label="Delete task"
      className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05]"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}

function formatLongDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
