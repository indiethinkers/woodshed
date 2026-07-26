import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const invokeMock = vi.fn();
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  useAllPeople,
  usePeopleMutations,
  usePerson,
  type PersonDto,
} from "./use-people";
import { resolveWikilink, setWikilinkTargets } from "@/lib/wikilinks";
import { invalidateForPath } from "@/lib/vault-events";

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makePerson(over: Partial<PersonDto> = {}): PersonDto {
  return {
    id: "alex-rivera",
    path: "people/alex-rivera.md",
    name: "Alex Rivera",
    initials: "AR",
    role: "Engineer",
    company: "Woodshed",
    email: "alex@woodshed.com",
    relationship: "",
    area: "woodshed",
    favorite: false,
    body: "",
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("usePeopleMutations.update — optimistic patches", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    setWikilinkTargets([]);
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("immediately patches the list when role changes", async () => {
    const initial = [makePerson()];
    qc.setQueryData(["people"], initial);

    invokeMock.mockResolvedValueOnce(makePerson({ role: "Staff Engineer" }));

    const { result } = renderHook(() => usePeopleMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "alex-rivera",
        update: { role: "Staff Engineer" },
      });
    });

    expect(qc.getQueryData<PersonDto[]>(["people"])?.[0].role).toBe(
      "Staff Engineer",
    );

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(resolveWikilink("Alex Rivera")?.href).toBe("/people/alex-rivera");
  });

  it("rolls back when the mutation fails", async () => {
    const initial = [makePerson()];
    qc.setQueryData(["people"], initial);

    invokeMock.mockRejectedValueOnce(new Error("disk full"));

    const { result } = renderHook(() => usePeopleMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "alex-rivera",
        update: { name: "broken rename" },
      });
    });

    expect(qc.getQueryData<PersonDto[]>(["people"])?.[0].name).toBe(
      "broken rename",
    );

    await waitFor(() => expect(result.current.update.isError).toBe(true));

    expect(qc.getQueryData<PersonDto[]>(["people"])?.[0].name).toBe("Alex Rivera");
  });
});

describe("usePeopleMutations.remove — optimistic delete", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    setWikilinkTargets([]);
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("immediately removes the person from the list", async () => {
    const initial = [
      makePerson({ id: "alex-rivera" }),
      makePerson({ id: "sam-chen", name: "Sam Chen" }),
    ];
    qc.setQueryData(["people"], initial);

    invokeMock.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => usePeopleMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.remove.mutate({ id: "alex-rivera" });
    });

    expect(qc.getQueryData<PersonDto[]>(["people"])?.map((p) => p.id)).toEqual([
      "sam-chen",
    ]);

    await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));
  });
});

describe("usePerson — selects from the shared list cache", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    setWikilinkTargets([]);
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  // The "Person not found" bug: the wikilink Create flow primed the
  // detail cache, the user navigated to /people/<id>, and a concurrent
  // background fetch (refetchOnMount or a watcher invalidation) called
  // person_get before people_all had populated the list — the fallback
  // chain found nothing and the page locked into "Person not found"
  // even though the file was on disk. The hook now selects directly
  // from the shared `["people"]` list query, so there's no second fetch
  // to race against and the detail is always in lockstep with the
  // panel listing.
  it("returns the matching row from the list cache", async () => {
    const alex = makePerson({ id: "alex-rivera" });
    qc.setQueryData(["people"], [alex, makePerson({ id: "sam-chen" })]);
    // people_all should NOT be called when the list cache is already
    // populated — usePerson reads from it directly.
    invokeMock.mockImplementation(() => {
      throw new Error("people_all should not be invoked when cache is warm");
    });

    const { result } = renderHook(() => usePerson("alex-rivera"), {
      wrapper: makeWrapper(qc),
    });

    expect(result.current.data).toEqual(alex);
  });

  it("returns null when the id is not in the loaded list", async () => {
    invokeMock.mockResolvedValueOnce([makePerson({ id: "alex-rivera" })]);

    const { result } = renderHook(() => usePerson("ghost"), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toBeNull();
  });

  it("never invokes person_get from the detail-page read path", async () => {
    qc.setQueryData(["people"], [makePerson({ id: "alex-rivera" })]);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "person_get") {
        throw new Error("usePerson must not call person_get");
      }
      return Promise.resolve([]);
    });

    renderHook(() => usePerson("alex-rivera"), { wrapper: makeWrapper(qc) });
    // Nothing to assert beyond the mock not throwing; the test passes
    // if usePerson never reaches the legacy per-id command.
  });

  it("keeps an open profile visible when an agent revision is written", async () => {
    qc.setQueryDefaults(["people"], { staleTime: Infinity });
    const avery = makePerson({
      id: "avery-stone",
      name: "Avery Stone",
      path: "people/avery-stone.md",
    });
    qc.setQueryData(["people"], [avery]);
    // If the hidden revision leaks into the global invalidation fallback, this
    // transient empty list response replaces the visible person with null.
    invokeMock.mockResolvedValueOnce([]);

    const { result } = renderHook(() => usePerson("avery-stone"), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current.data?.name).toBe("Avery Stone");

    await act(async () => {
      invalidateForPath(
        qc,
        ".woodshed/revisions/agent/agent-chat.md/20260725T215914.md",
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.data?.name).toBe("Avery Stone");
  });
});

describe("usePeopleMutations.create", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    setWikilinkTargets([]);
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("inserts the created person into the list", async () => {
    qc.setQueryData(["people"], []);

    const created = makePerson({ id: "new-friend", name: "New Friend" });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "person_create") return Promise.resolve(created);
      if (cmd === "people_all") return Promise.resolve([created]);
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => usePeopleMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.create.mutate({
        name: "New Friend",
        role: "Designer",
        company: "Acme",
        email: "new@acme.com",
        area: "woodshed",
      });
    });

    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    const list = qc.getQueryData<PersonDto[]>(["people"]);
    expect(list?.map((p) => p.id)).toContain("new-friend");
    expect(resolveWikilink("New Friend")?.href).toBe("/people/new-friend");
    expect(resolveWikilink("new-friend")?.href).toBe("/people/new-friend");
  });

  it("refetches the full list after create if the initial list was still loading", async () => {
    const existing = makePerson({ id: "alex-rivera", name: "Alex Rivera" });
    const created = makePerson({ id: "robin-hart", name: "Robin Hart" });
    const initialFetch = deferred<PersonDto[]>();
    let peopleAllCalls = 0;

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "people_all") {
        peopleAllCalls += 1;
        if (peopleAllCalls === 1) return initialFetch.promise;
        return Promise.resolve([created, existing]);
      }
      if (cmd === "person_create") return Promise.resolve(created);
      return Promise.resolve(null);
    });

    const { result } = renderHook(
      () => ({
        all: useAllPeople(),
        mutations: usePeopleMutations(),
      }),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(peopleAllCalls).toBe(1));

    act(() => {
      result.current.mutations.create.mutate({
        name: "Robin Hart",
        role: "Founder",
        company: "Example Studio",
        email: "",
        area: "woodshed",
      });
    });

    await waitFor(() => expect(result.current.mutations.create.isSuccess).toBe(true));

    expect(qc.getQueryData<PersonDto[]>(["people"])?.map((p) => p.id)).toEqual([
      "robin-hart",
      "alex-rivera",
    ]);

    initialFetch.resolve([existing]);
  });
});
