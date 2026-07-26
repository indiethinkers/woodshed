import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock the Tauri layer so we can drive the mutation from tests.
const invokeMock = vi.fn();
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  useDailyJournalMutation,
  type DailyJournalDto,
} from "./use-daily-journal";

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const DATE = "2026-06-11";

function makeDto(over: Partial<DailyJournalDto> = {}): DailyJournalDto {
  return { date: DATE, path: `cadence/${DATE}.md`, body: "", ...over };
}

describe("useDailyJournalMutation — stale-base rejection", () => {
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

  it("refetches the fresh on-disk body instead of dropping the edit", async () => {
    // The fresh body on disk already contains an external edit the editor
    // never saw — exactly the note a naive overwrite would clobber.
    const freshBody = "old base\n- [09:00] newer note";

    invokeMock.mockImplementation(
      (cmd: string, args: { date: string }) => {
        if (cmd === "daily_save") {
          // Backend refuses the stale-base autosave with the load-bearing token.
          return Promise.reject(
            new Error(
              `stale-base: cadence/${args.date}.md changed on disk since this editor loaded; reload before saving`,
            ),
          );
        }
        if (cmd === "daily_get") {
          // The refetch hits daily_get and returns the merged on-disk body.
          return Promise.resolve(makeDto({ body: freshBody }));
        }
        return Promise.resolve(null);
      },
    );

    const { result } = renderHook(() => useDailyJournalMutation(), {
      wrapper: makeWrapper(qc),
    });

    let returned: DailyJournalDto | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync({
        date: DATE,
        body: "old base", // stale: missing the captured bullet
        previousBody: "old base",
      });
    });

    // The mutation resolves (no thrown error → no dropped edit) and surfaces
    // the captured note, and the cache holds it so the editor re-hydrates.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(returned?.body).toBe(freshBody);
    expect(
      qc.getQueryData<DailyJournalDto>(["dailyJournal", DATE])?.body,
    ).toBe(freshBody);

    // A daily_get refetch was actually issued (not silently swallowed).
    expect(
      invokeMock.mock.calls.some(([cmd]) => cmd === "daily_get"),
    ).toBe(true);
  });

  it("propagates non-stale-base errors instead of swallowing them", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "daily_save") {
        return Promise.reject(new Error("disk full"));
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useDailyJournalMutation(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current
        .mutateAsync({ date: DATE, body: "edited", previousBody: "edited" })
        .catch(() => {});
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // No spurious refetch for a genuine failure.
    expect(
      invokeMock.mock.calls.some(([cmd]) => cmd === "daily_get"),
    ).toBe(false);
  });

  it("writes the saved DTO into the cache on a normal save", async () => {
    const saved = makeDto({ body: "fresh content" });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "daily_save" ? Promise.resolve(saved) : Promise.resolve(null),
    );

    const { result } = renderHook(() => useDailyJournalMutation(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({
        date: DATE,
        body: "fresh content",
        previousBody: "",
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      qc.getQueryData<DailyJournalDto>(["dailyJournal", DATE])?.body,
    ).toBe("fresh content");
  });
});
