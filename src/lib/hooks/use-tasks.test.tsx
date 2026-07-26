import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock the Tauri layer so we can drive the hook from tests.
const invokeMock = vi.fn();
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useTaskMutations, type TaskDto } from "./use-tasks";

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeTask(over: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "t_001",
    path: "tasks/t_001.md",
    content: "Ship pricing rewrite",
    status: "backlog",
    area: "woodshed",
    scheduled: "2026-04-25",
    tags: ["task"],
    timeSpentSeconds: 0,
    sortKey: 0,
    body: "",
    ...over,
  };
}

describe("useTaskMutations.update — optimistic patches", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("immediately patches the list when status changes (optimistic)", async () => {
    const initial = [makeTask()];
    qc.setQueryData(["tasks", "2026-04-25"], initial);
    qc.setQueryData(["task", "t_001"], initial[0]);

    invokeMock.mockResolvedValueOnce(makeTask({ status: "in-progress" }));

    const { result } = renderHook(() => useTaskMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "t_001",
        update: { status: "in-progress" },
      });
    });

    // Optimistic patch fires before the await
    const optimistic = qc.getQueryData<TaskDto[]>(["tasks", "2026-04-25"]);
    expect(optimistic?.[0].status).toBe("in-progress");
    expect(qc.getQueryData<TaskDto>(["task", "t_001"])?.status).toBe(
      "in-progress",
    );

    await waitFor(() =>
      expect(result.current.update.isSuccess).toBe(true),
    );
  });

  it("rolls back the list when the mutation fails", async () => {
    const initial = [makeTask()];
    qc.setQueryData(["tasks", "2026-04-25"], initial);
    qc.setQueryData(["task", "t_001"], initial[0]);

    invokeMock.mockRejectedValueOnce(new Error("disk full"));

    const { result } = renderHook(() => useTaskMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "t_001",
        update: { status: "done" },
      });
    });

    // Optimistic patch fired
    expect(
      qc.getQueryData<TaskDto[]>(["tasks", "2026-04-25"])?.[0].status,
    ).toBe("done");

    // Rollback after the rejection
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect(
      qc.getQueryData<TaskDto[]>(["tasks", "2026-04-25"])?.[0].status,
    ).toBe("backlog");
    expect(qc.getQueryData<TaskDto>(["task", "t_001"])?.status).toBe(
      "backlog",
    );
  });
});

describe("useTaskMutations.remove — optimistic delete", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("immediately removes the task from the list", async () => {
    const initial = [makeTask({ id: "t_001" }), makeTask({ id: "t_002" })];
    qc.setQueryData(["tasks", "2026-04-25"], initial);

    invokeMock.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useTaskMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.remove.mutate({ id: "t_001" });
    });

    expect(
      qc.getQueryData<TaskDto[]>(["tasks", "2026-04-25"])?.map((t) => t.id),
    ).toEqual(["t_002"]);

    await waitFor(() =>
      expect(result.current.remove.isSuccess).toBe(true),
    );
  });

  it("restores the deleted task on failure", async () => {
    const initial = [makeTask({ id: "t_001" }), makeTask({ id: "t_002" })];
    qc.setQueryData(["tasks", "2026-04-25"], initial);

    invokeMock.mockRejectedValueOnce(new Error("permission denied"));

    const { result } = renderHook(() => useTaskMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.remove.mutate({ id: "t_001" });
    });

    await waitFor(() => expect(result.current.remove.isError).toBe(true));
    expect(
      qc.getQueryData<TaskDto[]>(["tasks", "2026-04-25"])?.map((t) => t.id),
    ).toEqual(["t_001", "t_002"]);
  });
});

describe("useTaskMutations.create", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("inserts the created task into the matching date list", async () => {
    qc.setQueryData(["tasks", "2026-04-25"], []);

    const created = makeTask({ id: "t_new", content: "Brand new" });
    invokeMock.mockResolvedValueOnce(created);

    const { result } = renderHook(() => useTaskMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.create.mutate({
        content: "Brand new",
        area: "woodshed",
        scheduled: "2026-04-25",
      });
    });

    await waitFor(() =>
      expect(result.current.create.isSuccess).toBe(true),
    );

    const list = qc.getQueryData<TaskDto[]>(["tasks", "2026-04-25"]);
    expect(list?.map((t) => t.id)).toContain("t_new");
  });
});
