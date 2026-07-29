import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { EventDto } from "@/lib/hooks/use-events";

const mocks = vi.hoisted(() => ({
  events: [] as EventDto[],
  gcalAccounts: [] as { id: string; color?: string }[],
  sync: { mutate: vi.fn(), isPending: false },
  isLoading: false,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    to,
  }: {
    children: ReactNode;
    className?: string;
    to: string;
  }) => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/cadence/2026-05-18" } }),
}));

vi.mock("@/lib/hooks/use-events", () => ({
  useEvents: () => ({
    data: mocks.isLoading ? undefined : mocks.events,
    isLoading: mocks.isLoading,
  }),
}));

vi.mock("@/lib/hooks/use-gcal", () => ({
  useGcalAccounts: () => ({ data: mocks.gcalAccounts }),
  useGcalSync: () => mocks.sync,
}));

vi.mock("@/lib/hooks/use-today", () => ({
  useToday: () => "2026-05-18",
}));

import { ScheduleBlock } from "./schedule-block";

function makeEvent(overrides: Partial<EventDto>): EventDto {
  return {
    id: "event",
    path: "events/event.md",
    title: "Event",
    date: "2026-05-18T11:00:00-07:00",
    duration: 30,
    area: "woodshed",
    attendees: [],
    resolvedAttendees: [],
    recurring: "none",
    tags: [],
    body: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-18T10:00:00-07:00"));
  mocks.events = [];
  mocks.gcalAccounts = [];
  mocks.sync.mutate.mockClear();
  mocks.sync.isPending = false;
  mocks.isLoading = false;
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ScheduleBlock event rows", () => {
  it("marks ended events as completed without muting active or upcoming events", () => {
    mocks.events = [
      makeEvent({
        id: "past",
        title: "Past sync",
        date: "2026-05-18T08:00:00-07:00",
        duration: 30,
      }),
      makeEvent({
        id: "active",
        title: "Active meeting",
        date: "2026-05-18T09:45:00-07:00",
        duration: 30,
      }),
      makeEvent({
        id: "future",
        title: "Future review",
        date: "2026-05-18T11:00:00-07:00",
        duration: 30,
      }),
    ];

    render(<ScheduleBlock date="2026-05-18" />);

    const past = screen.getByRole("link", { name: "Past sync" });
    expect(past).toHaveClass("line-through");
    expect(past).toHaveClass("text-muted-foreground/60");
    expect(past.closest("li")).toHaveAttribute(
      "data-event-state",
      "completed",
    );

    const active = screen.getByRole("link", { name: "Active meeting" });
    expect(active).not.toHaveClass("line-through");
    expect(active.closest("li")).toHaveAttribute(
      "data-event-state",
      "upcoming",
    );

    const future = screen.getByRole("link", { name: "Future review" });
    expect(future).not.toHaveClass("line-through");
    expect(future.closest("li")).toHaveAttribute(
      "data-event-state",
      "upcoming",
    );
  });

  it("updates an active event once its end time passes", async () => {
    mocks.events = [
      makeEvent({
        id: "active",
        title: "Active meeting",
        date: "2026-05-18T09:45:00-07:00",
        duration: 30,
      }),
      makeEvent({
        id: "future",
        title: "Future review",
        date: "2026-05-18T11:00:00-07:00",
        duration: 30,
      }),
    ];

    render(<ScheduleBlock date="2026-05-18" />);

    const active = screen.getByRole("link", { name: "Active meeting" });
    expect(active).not.toHaveClass("line-through");

    await act(async () => {
      vi.setSystemTime(new Date("2026-05-18T10:16:00-07:00"));
      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    });

    expect(active).toHaveClass("line-through");
    expect(active.closest("li")).toHaveAttribute(
      "data-event-state",
      "completed",
    );
  });
});

describe("ScheduleBlock loading state", () => {
  it("renders a quiet, footprint-reserving placeholder while loading", () => {
    mocks.isLoading = true;
    const { container } = render(
      <ScheduleBlock date="2026-05-18" variant="sidebar" />,
    );
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(container.querySelector(".min-h-\\[182px\\]")).not.toBeNull();
    mocks.isLoading = false;
  });

  it("does not replay the enter animation for a restored expanded schedule", () => {
    window.localStorage.setItem(
      "woodshed:cadence:schedule-collapsed",
      "false",
    );
    mocks.events = [
      makeEvent({
        id: "finished",
        title: "Finished event",
        date: "2026-05-18T08:00:00-07:00",
        duration: 30,
      }),
    ];

    const { container } = render(<ScheduleBlock date="2026-05-18" />);

    expect(screen.getByRole("link", { name: "Finished event" })).toBeVisible();
    expect(container.querySelector("ul")).not.toHaveClass("animate-in");
  });
});
