import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const invokeMock = vi.fn();
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useResourceMutations, type ResourceDto } from "./use-resources";

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeResource(over: Partial<ResourceDto> = {}): ResourceDto {
  return {
    id: "local-first",
    path: "resources/local-first.md",
    title: "Local-first software",
    url: "https://example.com/local-first",
    source: "example.com",
    saved: "2026-04-10T09:15:00-04:00",
    tags: [],
    highlights: [],
    favorite: false,
    body: "",
    ...over,
  };
}

describe("useResourceMutations.update — optimistic patches", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  it("immediately patches the list when title changes", async () => {
    const initial = [makeResource()];
    qc.setQueryData(["resources"], initial);
    qc.setQueryData(["resource", "local-first"], initial[0]);

    invokeMock.mockResolvedValueOnce(makeResource({ title: "Local-first v2" }));

    const { result } = renderHook(() => useResourceMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "local-first",
        update: { title: "Local-first v2" },
      });
    });

    expect(qc.getQueryData<ResourceDto[]>(["resources"])?.[0].title).toBe(
      "Local-first v2",
    );

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
  });

  it("rolls back when the mutation fails", async () => {
    const initial = [makeResource()];
    qc.setQueryData(["resources"], initial);

    invokeMock.mockRejectedValueOnce(new Error("disk full"));

    const { result } = renderHook(() => useResourceMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "local-first",
        update: { title: "broken" },
      });
    });

    expect(qc.getQueryData<ResourceDto[]>(["resources"])?.[0].title).toBe(
      "broken",
    );

    await waitFor(() => expect(result.current.update.isError).toBe(true));

    expect(qc.getQueryData<ResourceDto[]>(["resources"])?.[0].title).toBe(
      "Local-first software",
    );
  });
});

describe("useResourceMutations.remove", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  it("immediately removes the resource from the list", async () => {
    const initial = [
      makeResource({ id: "a" }),
      makeResource({ id: "b", title: "Other" }),
    ];
    qc.setQueryData(["resources"], initial);

    invokeMock.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useResourceMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.remove.mutate({ id: "a" });
    });

    expect(
      qc.getQueryData<ResourceDto[]>(["resources"])?.map((b) => b.id),
    ).toEqual(["b"]);

    await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));
  });
});

describe("useResourceMutations.create", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  it("inserts the created resource at the top (newest first)", async () => {
    const old = makeResource({
      id: "old",
      title: "Old",
      saved: "2024-01-01T00:00:00-04:00",
    });
    qc.setQueryData(["resources"], [old]);

    const created = makeResource({
      id: "new",
      title: "New",
      saved: "2026-04-25T09:00:00-04:00",
    });
    invokeMock.mockResolvedValueOnce(created);

    const { result } = renderHook(() => useResourceMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.create.mutate({
        title: "New",
        url: "https://example.com/new",
      });
    });

    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    const list = qc.getQueryData<ResourceDto[]>(["resources"]);
    expect(list?.map((b) => b.id)).toEqual(["new", "old"]);
  });
});

describe("useResourceMutations.capture", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  it("sends metadata fields to the capture command", async () => {
    const captured = makeResource({
      id: "article",
      title: "Article",
      author: "jasmine-sun",
    });
    invokeMock.mockResolvedValueOnce(captured);

    const { result } = renderHook(() => useResourceMutations(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.capture.mutateAsync({
        url: "https://example.com/article",
        title: "Article",
        author: "Jasmine Sun",
        published: "2026-04-30",
      });
    });

    expect(invokeMock).toHaveBeenCalledWith("resource_capture_url", {
        input: {
          url: "https://example.com/article",
          tags: [],
          title: "Article",
        source: null,
        author: "Jasmine Sun",
        published: "2026-04-30",
        highlights: [],
        skipDailyLog: false,
      },
    });
  });
});
