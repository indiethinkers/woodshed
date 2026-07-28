import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type InfiniteData,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSummary, MailPage } from "@/lib/mail-lib/types";

const invokeMock = vi.fn();
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useArchiveOne, useMail, useMarkRead } from "./use-mail";

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

function makeMailData(...emails: EmailSummary[]): InfiniteData<MailPage, number> {
  return {
    pages: [{ items: emails, nextOffset: null }],
    pageParams: [0],
  };
}

function cachedEmails(qc: QueryClient): EmailSummary[] | undefined {
  return qc
    .getQueryData<InfiniteData<MailPage, number>>(["emails"])
    ?.pages.flatMap((page) => page.items);
}

describe("useMarkRead", () => {
  it("clears unread state everywhere an opened thread is rendered", async () => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const email = makeEmail();
    qc.setQueryData(["emails"], makeMailData(email));
    qc.setQueryData(["email", email.id], email);
    qc.setQueryData(["thread", email.threadId], [email]);
    invokeMock.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useMarkRead(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current(email.id);
    });

    expect(cachedEmails(qc)?.[0]).toMatchObject({ read: true });
    expect(qc.getQueryData<EmailSummary>(["email", email.id])).toMatchObject({
      read: true,
    });
    expect(
      qc.getQueryData<EmailSummary[]>(["thread", email.threadId])?.[0],
    ).toMatchObject({ read: true });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe("useArchiveOne", () => {
  let qc: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset();
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
  });

  it("keeps the row removed when a refetch restores it before archive completes", async () => {
    const email = makeEmail();
    qc.setQueryData(["emails"], makeMailData(email));

    let finishArchive!: () => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishArchive = resolve;
        }),
    );

    const { result } = renderHook(
      () => ({ archiveOne: useArchiveOne(), inbox: useMail() }),
      {
        wrapper: makeWrapper(qc),
      },
    );

    let archivePromise!: Promise<void>;
    await act(async () => {
      archivePromise = result.current.archiveOne(email.id);
      await Promise.resolve();
    });
    expect(cachedEmails(qc)).toEqual([]);
    await waitFor(() => expect(result.current.inbox.data).toEqual([]));

    // Navigating back to /mail mounts the list while the archive is still
    // pending. A local-disk refetch can still contain the source file.
    await act(async () => {
      qc.setQueryData(["emails"], makeMailData(email));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(cachedEmails(qc)).toEqual([email]);
    expect(result.current.inbox.data).toEqual([]);

    await act(async () => {
      finishArchive();
      await archivePromise;
    });

    expect(cachedEmails(qc)).toEqual([]);
    expect(result.current.inbox.data).toEqual([]);
  });

  it("ignores a stale inbox refetch that finishes after archive completes", async () => {
    const email = makeEmail();
    qc.setQueryData(["emails"], makeMailData(email));

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
    expect(cachedEmails(qc)).toEqual([]);

    let finishStaleRefetch!: () => void;
    const staleRefetch = qc.fetchInfiniteQuery({
      queryKey: ["emails"],
      queryFn: () =>
        new Promise<MailPage>((resolve) => {
          finishStaleRefetch = () =>
            resolve({ items: [email], nextOffset: null });
        }),
      initialPageParam: 0,
      getNextPageParam: (lastPage: MailPage) =>
        lastPage.nextOffset ?? undefined,
      staleTime: 0,
    });

    await act(async () => {
      finishArchive();
      await archivePromise;
    });
    expect(cachedEmails(qc)).toEqual([]);

    await act(async () => {
      finishStaleRefetch();
      await staleRefetch;
    });

    expect(cachedEmails(qc)).toEqual([]);
  });

  it("does not resurrect a sibling whose concurrent archive succeeded", async () => {
    const first = makeEmail({ id: "message-1" });
    const second = makeEmail({ id: "message-2" });
    qc.setQueryData(["emails"], makeMailData(first, second));

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

    expect(cachedEmails(qc)).toEqual([first]);
  });
});
