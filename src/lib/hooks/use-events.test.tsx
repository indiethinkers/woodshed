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
  useEventMutations,
  useIcalEvent,
  useIcalEventSaveNotes,
  type EventDto,
} from "./use-events";

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeEvent(over: Partial<EventDto> = {}): EventDto {
  return {
    id: "e_001",
    path: "cadence/alex-1on1-2026-04-25.md",
    title: "Alex 1:1",
    date: "2026-04-25T08:00:00-04:00",
    duration: 30,
    area: "acme",
    attendees: [],
    resolvedAttendees: [],
    recurring: "weekly",
    body: "",
    ...over,
  };
}

describe("useIcalEvent", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("passes the projected occurrence date to the backend", async () => {
    const event = makeEvent({
      id: "e_gcal_001",
      provider: "ical",
      accountId: "gcal_A",
      externalId: "uid@google.com",
      date: "2026-05-18T15:30:00+00:00",
    });
    invokeMock.mockResolvedValueOnce(event);

    const { result } = renderHook(
      () => useIcalEvent("gcal_A", "uid@google.com", "2026-05-18"),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invokeMock).toHaveBeenCalledWith("event_ical_get", {
      accountId: "gcal_A",
      externalId: "uid@google.com",
      occurrenceDate: "2026-05-18",
    });
    expect(
      qc.getQueryData<EventDto>([
        "event",
        "ical",
        "gcal_A",
        "uid@google.com",
        "2026-05-18",
      ])?.date,
    ).toBe("2026-05-18T15:30:00+00:00");
    expect(
      qc.getQueryData<EventDto>([
        "event",
        "ical",
        "gcal_A",
        "uid@google.com",
      ])?.title,
    ).toBe("Alex 1:1");
  });
});

describe("useIcalEventSaveNotes", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("keeps saves scoped to the selected occurrence cache", async () => {
    const saved = makeEvent({
      id: "e_gcal_001",
      provider: "ical",
      accountId: "gcal_A",
      externalId: "uid@google.com",
      date: "2026-05-18T15:30:00+00:00",
      body: "- notes",
    });
    invokeMock.mockResolvedValueOnce(saved);

    const { result } = renderHook(() => useIcalEventSaveNotes(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({
        accountId: "gcal_A",
        externalId: "uid@google.com",
        occurrenceDate: "2026-05-18",
        body: "- notes",
      });
    });

    expect(invokeMock).toHaveBeenCalledWith("event_ical_save_notes", {
      accountId: "gcal_A",
      externalId: "uid@google.com",
      occurrenceDate: "2026-05-18",
      body: "- notes",
      title: null,
      date: null,
      duration: null,
      area: null,
    });
    expect(
      qc.getQueryData<EventDto>([
        "event",
        "ical",
        "gcal_A",
        "uid@google.com",
        "2026-05-18",
      ])?.body,
    ).toBe("- notes");
  });
});

describe("useEventMutations.update — optimistic patches", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("immediately patches the list and single-event cache when the title changes", async () => {
    const initial = [makeEvent()];
    qc.setQueryData(["events", "2026-04-25"], initial);
    qc.setQueryData(["event", "e_001"], initial[0]);

    invokeMock.mockResolvedValueOnce(makeEvent({ title: "Alex 1:1 (renamed)" }));

    const { result } = renderHook(() => useEventMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "e_001",
        update: { title: "Alex 1:1 (renamed)" },
      });
    });

    expect(
      qc.getQueryData<EventDto[]>(["events", "2026-04-25"])?.[0].title,
    ).toBe("Alex 1:1 (renamed)");
    expect(qc.getQueryData<EventDto>(["event", "e_001"])?.title).toBe(
      "Alex 1:1 (renamed)",
    );

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
  });

  it("rolls back when the mutation fails", async () => {
    const initial = [makeEvent()];
    qc.setQueryData(["events", "2026-04-25"], initial);
    qc.setQueryData(["event", "e_001"], initial[0]);

    invokeMock.mockRejectedValueOnce(new Error("disk full"));

    const { result } = renderHook(() => useEventMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.update.mutate({
        id: "e_001",
        update: { title: "broken rename" },
      });
    });

    expect(
      qc.getQueryData<EventDto[]>(["events", "2026-04-25"])?.[0].title,
    ).toBe("broken rename");

    await waitFor(() => expect(result.current.update.isError).toBe(true));

    expect(
      qc.getQueryData<EventDto[]>(["events", "2026-04-25"])?.[0].title,
    ).toBe("Alex 1:1");
    expect(qc.getQueryData<EventDto>(["event", "e_001"])?.title).toBe("Alex 1:1");
  });
});

describe("useEventMutations.remove — optimistic delete", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("immediately removes the event from the list", async () => {
    const initial = [
      makeEvent({ id: "e_001" }),
      makeEvent({ id: "e_002" }),
    ];
    qc.setQueryData(["events", "2026-04-25"], initial);

    invokeMock.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useEventMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.remove.mutate({ id: "e_001" });
    });

    expect(
      qc.getQueryData<EventDto[]>(["events", "2026-04-25"])?.map((e) => e.id),
    ).toEqual(["e_002"]);

    await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));
  });

  it("restores the deleted event on failure", async () => {
    const initial = [
      makeEvent({ id: "e_001" }),
      makeEvent({ id: "e_002" }),
    ];
    qc.setQueryData(["events", "2026-04-25"], initial);

    invokeMock.mockRejectedValueOnce(new Error("permission denied"));

    const { result } = renderHook(() => useEventMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.remove.mutate({ id: "e_001" });
    });

    await waitFor(() => expect(result.current.remove.isError).toBe(true));
    expect(
      qc.getQueryData<EventDto[]>(["events", "2026-04-25"])?.map((e) => e.id),
    ).toEqual(["e_001", "e_002"]);
  });
});

describe("useEventMutations.create", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("inserts the created event into the matching date list", async () => {
    qc.setQueryData(["events", "2026-04-25"], []);

    const created = makeEvent({ id: "e_new", title: "Standup" });
    invokeMock.mockResolvedValueOnce(created);

    const { result } = renderHook(() => useEventMutations(), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.create.mutate({
        title: "Standup",
        date: "2026-04-25T09:00:00-04:00",
        duration: 15,
        area: "woodshed",
      });
    });

    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    const list = qc.getQueryData<EventDto[]>(["events", "2026-04-25"]);
    expect(list?.map((e) => e.id)).toContain("e_new");
  });
});
