import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDto } from "@/lib/hooks/use-tasks";

const mocks = vi.hoisted(() => {
  const taskFixtures: TaskDto[] = [
    {
      id: "t_alpha",
      path: "tasks/t_alpha.md",
      content: "Alpha task",
      status: "backlog",
      area: "woodshed",
      created: "2026-05-18T08:00:00-07:00",
      scheduled: "2026-05-18",
      tags: ["task"],
      timeSpentSeconds: 0,
      sortKey: 1000,
      body: "",
    },
    {
      id: "t_beta",
      path: "tasks/t_beta.md",
      content: "Beta task",
      status: "backlog",
      area: "woodshed",
      created: "2026-05-18T09:00:00-07:00",
      scheduled: "2026-05-18",
      tags: ["task"],
      timeSpentSeconds: 0,
      sortKey: 2000,
      body: "",
    },
  ];
  const tasks: TaskDto[] = [];

  return {
    create: { mutate: vi.fn() },
    navigate: vi.fn(),
    pauseTimer: { mutate: vi.fn() },
    remove: { mutate: vi.fn() },
    reorder: { mutate: vi.fn() },
    resetTasks: () => {
      tasks.splice(0, tasks.length, ...taskFixtures.map((task) => ({ ...task })));
    },
    resumeTimer: { mutate: vi.fn() },
    tasks,
    update: { mutate: vi.fn() },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/cadence/2026-05-18" } }),
}));

vi.mock("@dnd-kit/core", () => ({
  closestCenter: vi.fn(),
  DndContext: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  useSortable: () => ({
    attributes: {},
    isDragging: false,
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
  }),
  verticalListSortingStrategy: {},
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("@/lib/hooks/use-today", () => ({
  useToday: () => "2026-05-18",
}));

vi.mock("@/lib/cadence/use-cadence-sidebar-date", () => ({
  useCadenceSidebarDate: () => "2026-05-18",
}));

vi.mock("@/lib/hooks/use-areas", () => ({
  useAreas: () => ({
    data: [
      {
        id: "woodshed",
        name: "Woodshed",
        color: "#3F3F46",
      },
    ],
  }),
}));

vi.mock("@/lib/hooks/use-tasks", () => ({
  useAllTasks: () => ({ data: mocks.tasks }),
  useTasks: () => ({ data: mocks.tasks }),
  useTaskMutations: () => ({
    create: mocks.create,
    pauseTimer: mocks.pauseTimer,
    remove: mocks.remove,
    reorder: mocks.reorder,
    resumeTimer: mocks.resumeTimer,
    update: mocks.update,
  }),
}));

import { DailyTasks, TaskSidebar } from "./task-sidebar";

function alphaOpenButton() {
  return screen.getByRole("button", { name: "Open task: Alpha task" });
}

beforeEach(() => {
  mocks.resetTasks();
  mocks.create.mutate.mockClear();
  mocks.navigate.mockClear();
  mocks.pauseTimer.mutate.mockClear();
  mocks.remove.mutate.mockClear();
  mocks.reorder.mutate.mockClear();
  mocks.resumeTimer.mutate.mockClear();
  mocks.update.mutate.mockClear();
  window.localStorage.clear();
});

describe("TaskSidebar task open gesture", () => {
  it("opens a task on a plain click", () => {
    render(<TaskSidebar />);

    const button = alphaOpenButton();
    fireEvent.pointerDown(button, {
      button: 0,
      clientX: 20,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.click(button);

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/cadence/$date/task/$id",
      params: { date: "2026-05-18", id: "t_alpha" },
    });
  });

  it("does not open a task after pointer movement crosses the drag threshold", () => {
    render(<TaskSidebar />);

    const button = alphaOpenButton();
    fireEvent.pointerDown(button, {
      button: 0,
      clientX: 20,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, {
      clientX: 20,
      clientY: 40,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 40,
      pointerId: 1,
    });
    fireEvent.click(button);

    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("does not render done checkboxes in sidebar task cards", () => {
    render(<TaskSidebar />);

    expect(screen.queryByRole("checkbox", {
      name: "Mark task done: Alpha task",
    })).not.toBeInTheDocument();
  });

  it("shows active task time spent and hides the date control in sidebar cards", () => {
    mocks.tasks[0].status = "in-progress";
    mocks.tasks[0].timeSpentSeconds = 3725;
    mocks.tasks[1].scheduled = undefined;

    render(<TaskSidebar />);

    expect(screen.getByText("1h 2m")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reschedule task/ }))
      .not.toBeInTheDocument();
  });
});

describe("DailyTasks collapse control", () => {
  it("defaults closed and restores the inline task list on demand", () => {
    render(<DailyTasks date="2026-05-18" />);

    expect(screen.queryByRole("button", { name: "Open task: Alpha task" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("2 tasks hidden.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all tasks" }));

    expect(screen.getByRole("button", { name: "Open task: Alpha task" }))
      .toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse all tasks" }),
    );

    expect(screen.queryByRole("button", { name: "Open task: Alpha task" }))
      .not.toBeInTheDocument();
  });

  it("defaults to active-task focus but still lets hidden tasks expand", () => {
    mocks.tasks[0].status = "in-progress";

    render(<DailyTasks date="2026-05-18" />);

    expect(screen.getByRole("button", { name: "Open task: Alpha task" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open task: Beta task" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("1 task hidden.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all tasks" }));

    expect(screen.getByRole("button", { name: "Open task: Beta task" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse all tasks" }))
      .toBeInTheDocument();
  });

  it("collapses when setting an inline task active", () => {
    render(<DailyTasks date="2026-05-18" />);

    fireEvent.click(screen.getByRole("button", { name: "Show all tasks" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Backlog" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Active" }));

    expect(mocks.update.mutate).toHaveBeenCalledWith({
      id: "t_alpha",
      update: { status: "in-progress" },
    });
    expect(
      window.localStorage.getItem("woodshed:cadence:inline-tasks-collapsed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Show all tasks" }))
      .toBeInTheDocument();
  });

  it("expands when completing an active task from the collapsed list", () => {
    mocks.tasks[0].status = "in-progress";
    window.localStorage.setItem("woodshed:cadence:inline-tasks-collapsed", "true");

    const view = render(<DailyTasks date="2026-05-18" />);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Mark task done: Alpha task" }),
    );

    expect(mocks.update.mutate).toHaveBeenCalledWith({
      id: "t_alpha",
      update: { status: "done" },
    });
    expect(
      window.localStorage.getItem("woodshed:cadence:inline-tasks-collapsed"),
    ).toBeNull();

    mocks.tasks[0].status = "done";
    view.rerender(<DailyTasks date="2026-05-18" />);

    expect(screen.getByRole("button", { name: "Collapse all tasks" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open task: Beta task" }))
      .toBeInTheDocument();
  });

  it("pauses a running active task without changing status", () => {
    mocks.tasks[0].status = "in-progress";
    mocks.tasks[0].inProgressStartedAt = "2026-05-18T08:00:00-07:00";

    render(<DailyTasks date="2026-05-18" />);

    const buttons = screen.getAllByRole("button");
    const activeIndex = buttons.findIndex(
      (button) => button.textContent === "Active",
    );
    const pauseIndex = buttons.findIndex(
      (button) => button.getAttribute("aria-label") === "Pause timer: Alpha task",
    );
    expect(activeIndex).toBeGreaterThan(-1);
    expect(pauseIndex).toBeGreaterThan(activeIndex);

    fireEvent.click(screen.getByRole("button", { name: "Pause timer: Alpha task" }));

    expect(mocks.pauseTimer.mutate).toHaveBeenCalledWith({ id: "t_alpha" });
    expect(mocks.update.mutate).not.toHaveBeenCalledWith({
      id: "t_alpha",
      update: { status: "backlog" },
    });
  });

  it("resumes a paused active task without changing status", () => {
    mocks.tasks[0].status = "in-progress";
    mocks.tasks[0].inProgressStartedAt = undefined;

    render(<DailyTasks date="2026-05-18" />);

    const pausedCard = screen
      .getByRole("button", { name: "Open task: Alpha task" })
      .closest("article");
    expect(pausedCard).toHaveAttribute("data-task-timer-state", "paused");
    expect(pausedCard?.className).toContain("hsl(208_82%_55%");
    expect(screen.getByText("Paused").closest("span")?.className).toContain(
      "text-sky-700/75",
    );
    expect(pausedCard).toHaveTextContent("Paused");
    expect(pausedCard).not.toHaveTextContent("Active");

    fireEvent.click(screen.getByRole("button", { name: "Resume timer: Alpha task" }));

    expect(mocks.resumeTimer.mutate).toHaveBeenCalledWith({ id: "t_alpha" });
    expect(mocks.update.mutate).not.toHaveBeenCalled();
  });

  it("returns to the default closed state across remounts", () => {
    const view = render(<DailyTasks date="2026-05-18" />);

    fireEvent.click(screen.getByRole("button", { name: "Show all tasks" }));
    expect(screen.getByRole("button", { name: "Open task: Alpha task" }))
      .toBeInTheDocument();

    view.unmount();
    render(<DailyTasks date="2026-05-19" />);

    expect(screen.getByRole("button", { name: "Show all tasks" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open task: Alpha task" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("2 tasks hidden.")).toBeInTheDocument();
  });

  it("expands before opening the new-task composer", () => {
    const view = render(<DailyTasks date="2026-05-18" />);

    fireEvent.click(screen.getByRole("button", { name: "New task" }));

    expect(screen.getByPlaceholderText("What needs to be done?"))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open task: Alpha task" }))
      .toBeInTheDocument();

    view.unmount();
    render(<DailyTasks date="2026-05-19" />);

    expect(screen.getByRole("button", { name: "Show all tasks" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open task: Alpha task" }))
      .not.toBeInTheDocument();
  });
});
