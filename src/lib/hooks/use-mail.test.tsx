import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type InfiniteData,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  shouldShowUnreadIndicator,
  type EmailFull,
  type EmailSummary,
  type MailPage,
} from "@/lib/mail-lib/types";

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

function makeMailData(
  ...emails: EmailSummary[]
): InfiniteData<MailPage, number> {
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
  beforeEach(() => {
    invokeMock.mockReset();
  });

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
    qc.setQueryData(["email-full", email.id, email.inbox], {
      ...email,
      to: ["reader@example.test"],
      cc: [],
    } satisfies EmailFull);
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
    expect(
      qc.getQueryData<EmailFull>(["email-full", email.id, email.inbox]),
    ).toMatchObject({ read: true });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a viewed message visually cleared when remote sync fails", async () => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const first = makeEmail({ id: "message-1" });
    const second = makeEmail({ id: "message-2" });
    qc.setQueryData(["emails"], makeMailData(first, second));
    qc.setQueryData(["email", first.id], first);
    qc.setQueryData(["email", second.id], second);
    qc.setQueryData(["thread", first.threadId], [first, second]);
    qc.setQueryData(["email-full", first.id, first.inbox], {
      ...first,
      to: [],
      cc: [],
    } satisfies EmailFull);

    let failFirst!: (error: Error) => void;
    invokeMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            failFirst = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useMarkRead(), {
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
      failFirst(new Error("provider_read_failed: remote read failed"));
      await expect(firstPromise).rejects.toThrow("remote read failed");
    });

    expect(cachedEmails(qc)).toMatchObject([
      { id: first.id, read: false, viewed: true },
      { id: second.id, read: true },
    ]);
    expect(qc.getQueryData<EmailSummary>(["email", first.id])).toMatchObject({
      read: false,
      viewed: true,
    });
    expect(qc.getQueryData<EmailSummary>(["email", second.id])).toMatchObject({
      read: true,
    });
    expect(
      qc.getQueryData<EmailSummary[]>(["thread", first.threadId]),
    ).toMatchObject([
      { id: first.id, read: false, viewed: true },
      { id: second.id, read: true },
    ]);
    expect(
      qc.getQueryData<EmailFull>(["email-full", first.id, first.inbox]),
    ).toMatchObject({ read: false, viewed: true });
  });

  it("deduplicates overlapping provider sync attempts for one message", async () => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const email = makeEmail();
    qc.setQueryData(["emails"], makeMailData(email));

    let finishSync!: () => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSync = resolve;
        }),
    );
    const { result } = renderHook(() => useMarkRead(), {
      wrapper: makeWrapper(qc),
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current(email.id);
      second = result.current(email.id);
    });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      finishSync();
      await Promise.all([first, second]);
    });
  });

  it("updates a thread cache that appears while provider sync is pending", async () => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const email = makeEmail();
    qc.setQueryData(["emails"], makeMailData(email));

    let failSync!: (error: Error) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSync = reject;
        }),
    );
    const { result } = renderHook(() => useMarkRead(), {
      wrapper: makeWrapper(qc),
    });

    let request!: Promise<void>;
    act(() => {
      request = result.current(email.id);
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    qc.setQueryData(["thread", "late-thread"], [email]);
    expect(
      shouldShowUnreadIndicator(
        qc.getQueryData<EmailSummary[]>(["thread", "late-thread"])![0],
      ),
    ).toBe(false);

    await act(async () => {
      failSync(new Error("provider_read_failed: synthetic provider failure"));
      await expect(request).rejects.toThrow("synthetic provider failure");
    });

    expect(
      qc.getQueryData<EmailSummary[]>(["thread", "late-thread"])?.[0],
    ).toMatchObject({ read: false, viewed: true });
  });

  it("cancels an in-flight stale thread read before marking viewed", async () => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const email = makeEmail();
    qc.setQueryData(["emails"], makeMailData(email));

    let resolveStale!: (emails: EmailSummary[]) => void;
    const staleFetch = qc.fetchQuery({
      queryKey: ["thread", "deferred-thread"],
      queryFn: () =>
        new Promise<EmailSummary[]>((resolve) => {
          resolveStale = resolve;
        }),
    });
    void staleFetch.catch(() => undefined);

    let failSync!: (error: Error) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSync = reject;
        }),
    );
    const { result } = renderHook(() => useMarkRead(), {
      wrapper: makeWrapper(qc),
    });

    let request!: Promise<void>;
    act(() => {
      request = result.current(email.id);
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    resolveStale([email]);
    await Promise.resolve();
    expect(
      qc.getQueryData<EmailSummary[]>(["thread", "deferred-thread"]),
    ).toBeUndefined();

    await act(async () => {
      failSync(new Error("provider_read_failed: synthetic provider failure"));
      await expect(request).rejects.toThrow("synthetic provider failure");
    });
  });

  it("cancels a stale thread read that starts while provider sync is pending", async () => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const email = makeEmail();
    qc.setQueryData(["emails"], makeMailData(email));

    let failSync!: (error: Error) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSync = reject;
        }),
    );
    const { result } = renderHook(() => useMarkRead(), {
      wrapper: makeWrapper(qc),
    });

    let request!: Promise<void>;
    act(() => {
      request = result.current(email.id);
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    let resolveStale!: (emails: EmailSummary[]) => void;
    const staleFetch = qc.fetchQuery({
      queryKey: ["thread", "started-during-sync"],
      queryFn: () =>
        new Promise<EmailSummary[]>((resolve) => {
          resolveStale = resolve;
        }),
    });
    void staleFetch.catch(() => undefined);

    await act(async () => {
      failSync(new Error("provider_read_failed: synthetic provider failure"));
      await expect(request).rejects.toThrow("synthetic provider failure");
    });
    resolveStale([email]);
    await Promise.resolve();

    expect(
      qc.getQueryData<EmailSummary[]>(["thread", "started-during-sync"]),
    ).toBeUndefined();
    expect(cachedEmails(qc)?.[0]).toMatchObject({
      read: false,
      viewed: true,
    });
  });

  it("restores the unread indicator when local viewed persistence fails", async () => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const email = makeEmail({ viewed: false });
    qc.setQueryData(["emails"], makeMailData(email));
    invokeMock.mockRejectedValueOnce(new Error("local persistence failed"));
    const { result } = renderHook(() => useMarkRead(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await expect(result.current(email.id)).rejects.toThrow(
        "local persistence failed",
      );
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(cachedEmails(qc)?.[0]).toMatchObject({
      read: false,
      viewed: false,
    });
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
