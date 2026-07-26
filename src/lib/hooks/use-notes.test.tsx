import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const invokeMock = vi.fn();
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useNote, useNoteMutations, type NoteDto } from "./use-notes";
import { resolveWikilink, setWikilinkTargets } from "@/lib/wikilinks";

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeNote(over: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "file-over-app",
    path: "notebook/file-over-app.md",
    revision: "rev-file-over-app",
    title: "File-over-app philosophy",
    area: "indie-thinkers",
    created: "2026-04-12T12:30:00",
    tags: ["essay"],
    favorite: false,
    body: "x",
    ...over,
  };
}

describe("useNoteMutations.update — optimistic patches", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    setWikilinkTargets([]);
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("immediately patches the list when title changes", async () => {
    const initial = [makeNote()];
    qc.setQueryData(["notes"], initial);

    invokeMock.mockResolvedValueOnce(makeNote({ title: "File-over-app v2" }));

    const { result } = renderHook(() => useNoteMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "file-over-app",
        update: { title: "File-over-app v2" },
      });
    });

    expect(qc.getQueryData<NoteDto[]>(["notes"])?.[0].title).toBe(
      "File-over-app v2",
    );

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith("note_update_title", {
      id: "file-over-app",
      input: {
        title: "File-over-app v2",
        expectedPath: "notebook/file-over-app.md",
        expectedCreated: "2026-04-12T12:30:00",
      },
    });
    expect(resolveWikilink("File-over-app v2")?.href).toBe(
      "/notebook/file-over-app",
    );
  });

  it("sends body updates through the revision-guarded command", async () => {
    const initial = [makeNote({ body: "old body", revision: "rev-old" })];
    qc.setQueryData(["notes"], initial);

    invokeMock.mockResolvedValueOnce(
      makeNote({ body: "new body", revision: "rev-new" }),
    );

    const { result } = renderHook(() => useNoteMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "file-over-app",
        update: { body: "new body" },
      });
    });

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith("note_update_body", {
      id: "file-over-app",
      input: {
        body: "new body",
        baseRevision: "rev-old",
        expectedPath: "notebook/file-over-app.md",
        expectedCreated: "2026-04-12T12:30:00",
      },
    });
  });

  it("does not optimistically patch body edits before disk confirms the save", async () => {
    const initial = [makeNote({ body: "old body", revision: "rev-old" })];
    qc.setQueryData(["notes"], initial);

    invokeMock.mockResolvedValueOnce(
      makeNote({ body: "new body", revision: "rev-new" }),
    );

    const { result } = renderHook(() => useNoteMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "file-over-app",
        update: { body: "new body" },
      });
    });

    expect(qc.getQueryData<NoteDto[]>(["notes"])?.[0].body).toBe("old body");

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(qc.getQueryData<NoteDto[]>(["notes"])?.[0].body).toBe("new body");
  });

  it("refreshes a stale body revision without rolling the cache back to the draft", async () => {
    const initial = [makeNote({ body: "saved body", revision: "rev-stale" })];
    qc.setQueryData(["notes"], initial);

    invokeMock
      .mockRejectedValueOnce(new Error("note changed on disk; reload before saving"))
      .mockResolvedValueOnce(
        makeNote({ body: "fresh disk body", revision: "rev-fresh" }),
      );

    const { result } = renderHook(() => useNoteMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "file-over-app",
        update: { body: "draft body" },
      });
    });

    expect(qc.getQueryData<NoteDto[]>(["notes"])?.[0].body).toBe("saved body");

    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect(invokeMock).toHaveBeenNthCalledWith(2, "note_get", {
      id: "file-over-app",
    });
    expect(qc.getQueryData<NoteDto[]>(["notes"])?.[0]).toMatchObject({
      body: "fresh disk body",
      revision: "rev-fresh",
    });
  });

  it("sends area clears through the metadata command", async () => {
    const initial = [makeNote({ area: "woodshed" })];
    qc.setQueryData(["notes"], initial);

    invokeMock.mockResolvedValueOnce(makeNote({ area: undefined }));

    const { result } = renderHook(() => useNoteMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "file-over-app",
        update: { area: null },
      });
    });

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith("note_update_metadata", {
      id: "file-over-app",
      input: {
        area: null,
        expectedPath: "notebook/file-over-app.md",
        expectedCreated: "2026-04-12T12:30:00",
      },
    });
  });

  it("rolls back when the mutation fails", async () => {
    const initial = [makeNote()];
    qc.setQueryData(["notes"], initial);

    invokeMock.mockRejectedValueOnce(new Error("disk full"));

    const { result } = renderHook(() => useNoteMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "file-over-app",
        update: { title: "broken" },
      });
    });

    expect(qc.getQueryData<NoteDto[]>(["notes"])?.[0].title).toBe("broken");

    await waitFor(() => expect(result.current.update.isError).toBe(true));

    expect(qc.getQueryData<NoteDto[]>(["notes"])?.[0].title).toBe(
      "File-over-app philosophy",
    );
  });
});

describe("useNoteMutations.remove", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    setWikilinkTargets([]);
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("immediately removes the note from the list", async () => {
    const initial = [
      makeNote({ id: "a" }),
      makeNote({ id: "b", title: "Other" }),
    ];
    qc.setQueryData(["notes"], initial);

    invokeMock.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useNoteMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.remove.mutate({ id: "a" });
    });

    expect(qc.getQueryData<NoteDto[]>(["notes"])?.map((n) => n.id)).toEqual(["b"]);

    await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));
  });
});

describe("useNote — selects from the shared list cache", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    setWikilinkTargets([]);
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("returns the matching row from the list", () => {
    const a = makeNote({ id: "a", title: "A" });
    qc.setQueryData(["notes"], [a, makeNote({ id: "b" })]);
    invokeMock.mockImplementation(() => {
      throw new Error("notes_all should not run when cache is warm");
    });

    const { result } = renderHook(() => useNote("a"), {
      wrapper: makeWrapper(qc),
    });

    expect(result.current.data).toEqual(a);
  });

  it("returns null when neither the loaded list nor the fallback lookup has the id", async () => {
    invokeMock
      .mockResolvedValueOnce([makeNote({ id: "a" })])
      .mockResolvedValueOnce(null);

    const { result } = renderHook(() => useNote("ghost"), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("note_get", { id: "ghost" });
  });

  it("falls back to note_get and repairs the shared list when the list misses an existing note", async () => {
    const ghost = makeNote({
      id: "ghost",
      path: "notebook/ghost.md",
      title: "Ghost note",
    });
    invokeMock
      .mockResolvedValueOnce([makeNote({ id: "a" })])
      .mockResolvedValueOnce(ghost);

    const { result } = renderHook(() => useNote("ghost"), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.data?.id).toBe("ghost"));
    expect(invokeMock).toHaveBeenCalledWith("note_get", { id: "ghost" });
    expect(qc.getQueryData<NoteDto[]>(["notes"])?.map((n) => n.id)).toEqual([
      "ghost",
      "a",
    ]);
  });

  it("does not report not-found while an empty list is refetching", async () => {
    qc.setQueryData(["notes"], []);
    invokeMock.mockImplementation(
      () =>
        new Promise<NoteDto[]>((resolve) =>
          setTimeout(() => resolve([makeNote()]), 50),
        ),
    );

    const { result } = renderHook(() => useNote("file-over-app"), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(true));
    expect(result.current.data).toBeUndefined();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.id).toBe("file-over-app");
  });

  it("treats a missing backend response as an error, not an empty notebook", async () => {
    invokeMock.mockResolvedValueOnce(null);

    renderHook(() => useNote("file-over-app"), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("notes_all"));
    await waitFor(() =>
      expect(qc.getQueryState(["notes"])?.status).toBe("error"),
    );
  });
});

describe("useNoteMutations.create", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    setWikilinkTargets([]);
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("inserts the created note at the top (newest first)", async () => {
    const old = makeNote({
      id: "old",
      title: "Old note",
      created: "2024-01-01T00:00:00",
    });
    qc.setQueryData(["notes"], [old]);

    const created = makeNote({
      id: "new",
      title: "New note",
      created: "2026-04-25T09:00:00",
    });
    invokeMock.mockResolvedValueOnce(created);

    const { result } = renderHook(() => useNoteMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.create.mutate({
        title: "New note",
        area: "woodshed",
      });
    });

    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    const list = qc.getQueryData<NoteDto[]>(["notes"]);
    expect(list?.map((n) => n.id)).toEqual(["new", "old"]);
    expect(resolveWikilink("New note")?.href).toBe("/notebook/new");
    expect(resolveWikilink("new")?.href).toBe("/notebook/new");
  });
});
