import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSummary } from "@/lib/mail-lib/types";

const invokeMock = vi.fn();
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useArchiveOne } from "./use-mail";

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeEmail(over: Partial<EmailSummary> = {}): EmailSummary {
  return {
    id: "message-1",
    threadId: "thread-1",
    from: "GitHub",
    fromEmail: "noreply@github.com",
    subject: "Repository transfer",
    body: "Body",
    html: null,
    preview: "Body",
    date: "2026-07-25T22:19:31-07:00",
    read: false,
    labels: ["inbox", "unread"],
    mentions: [],
    links: [],
    inbox: "gmail:alex@example.com",
    path: "inbox/repository-transfer-message.md",
    attachments: [],
    ...over,
  };
}

describe("useArchiveOne", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it("keeps the row removed when a refetch restores it before archive completes", async () => {
    const email = makeEmail();
    qc.setQueryData(["emails"], [email]);

    let finishArchive!: () => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishArchive = resolve;
        }),
    );

    const { result } = renderHook(() => useArchiveOne(), {
      wrapper: makeWrapper(qc),
    });

    let archivePromise!: Promise<void>;
    act(() => {
      archivePromise = result.current(email.id);
    });
    expect(qc.getQueryData<EmailSummary[]>(["emails"])).toEqual([]);

    // Navigating back to /mail mounts an empty list as stale. Its local-disk
    // refetch can finish before the archive command moves the file.
    act(() => {
      qc.setQueryData(["emails"], [email]);
    });

    await act(async () => {
      finishArchive();
      await archivePromise;
    });

    expect(qc.getQueryData<EmailSummary[]>(["emails"])).toEqual([]);
  });

  it("does not resurrect a sibling whose concurrent archive succeeded", async () => {
    const first = makeEmail({ id: "message-1" });
    const second = makeEmail({ id: "message-2" });
    qc.setQueryData(["emails"], [first, second]);

    let failFirst!: (error: Error) => void;
    invokeMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            failFirst = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useArchiveOne(), {
      wrapper: makeWrapper(qc),
    });

    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current(first.id);
      secondPromise = result.current(second.id);
    });

    await act(async () => {
      await secondPromise;
      failFirst(new Error("remote archive failed"));
      await expect(firstPromise).rejects.toThrow("remote archive failed");
    });

    expect(qc.getQueryData<EmailSummary[]>(["emails"])).toEqual([first]);
  });
});
