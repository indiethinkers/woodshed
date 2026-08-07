import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/lib/agent/transport";

const mocks = vi.hoisted(() => ({
  runs: [] as AgentRun[],
  navigate: vi.fn(),
}));

vi.mock("@/lib/hooks/use-agent-runs", () => ({
  useActiveAgentRuns: () => ({ data: mocks.runs }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactElement;
  }) => React.cloneElement(render, undefined, children),
  TooltipContent: () => null,
}));

import { AgentWorkingIndicator } from "./agent-working-indicator";

function run(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: "run-1",
    conversationId: "conv-1",
    sessionId: "session-1",
    assistantMessageId: "msg-1",
    status: "running",
    createdAt: "2026-08-06T19:00:00.000Z",
    updatedAt: "2026-08-06T19:00:01.000Z",
    inputMessage: {
      id: "in-1",
      role: "user",
      createdAt: "2026-08-06T19:00:00.000Z",
      content: "hello",
    },
    events: [],
    ...overrides,
  };
}

function renderIndicator() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentWorkingIndicator />
    </QueryClientProvider>,
  );
}

describe("AgentWorkingIndicator", () => {
  beforeEach(() => {
    mocks.runs = [];
    mocks.navigate.mockReset();
  });

  it("renders nothing when no agent run is active", () => {
    mocks.runs = [run({ status: "completed" }), run({ status: "failed" })];
    renderIndicator();
    expect(
      screen.queryByRole("button", { name: "Cadence is working" }),
    ).not.toBeInTheDocument();
  });

  it("renders a working indicator while a run is queued or running", () => {
    mocks.runs = [run({ status: "completed" }), run({ status: "queued" })];
    renderIndicator();
    expect(
      screen.getByRole("button", { name: "Cadence is working" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cadence is working" }).querySelector(
        ".animate-pulse",
      ),
    ).toBeInTheDocument();
  });

  it("navigates to the Agent surface when clicked", () => {
    mocks.runs = [run({ status: "running" })];
    renderIndicator();
    fireEvent.click(
      screen.getByRole("button", { name: "Cadence is working" }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/agent" });
  });
});
