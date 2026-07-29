"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import {
  inboxesList,
  mailArchiveOne,
  mailDeleteOne,
  mailDraftDelete,
  mailDraftSave,
  mailGetFull,
  mailGetLocal,
  mailInboxPage,
  mailMarkRead,
  mailReply,
  mailSend,
  mailSyncRecentMulti,
  mailThread,
} from "@/lib/mail-lib";
import type {
  ComposeInput,
  DraftDto,
  DraftSaveInput,
  EmailFull,
  EmailSummary,
  Inbox,
  MailPage,
  MailSyncResult,
  ReplyInput,
  SendResult,
} from "@/lib/mail-lib/types";

type MailCache = InfiniteData<MailPage, number>;

const HIDDEN_ARCHIVE_IDS_KEY = ["mail-hidden-archive-ids"] as const;
const EMPTY_ARCHIVE_IDS: string[] = [];

interface CachedEmailLocation {
  email: EmailSummary;
  pageIndex: number;
  itemIndex: number;
}

function findCachedEmail(
  cache: MailCache | undefined,
  id: string,
): CachedEmailLocation | undefined {
  if (!cache) return undefined;
  for (let pageIndex = 0; pageIndex < cache.pages.length; pageIndex++) {
    const itemIndex = cache.pages[pageIndex].items.findIndex(
      (email) => email.id === id,
    );
    if (itemIndex >= 0) {
      return {
        email: cache.pages[pageIndex].items[itemIndex],
        pageIndex,
        itemIndex,
      };
    }
  }
  return undefined;
}

function updateCachedEmails(
  cache: MailCache | undefined,
  update: (email: EmailSummary) => EmailSummary | null,
): MailCache | undefined {
  if (!cache) return cache;
  return {
    ...cache,
    pages: cache.pages.map((page) => ({
      ...page,
      items: page.items.flatMap((email) => {
        const next = update(email);
        return next ? [next] : [];
      }),
    })),
  };
}

function asRead<T extends EmailSummary>(email: T): T {
  const labels = email.labels.filter(
    (label) => label.toLowerCase() !== "unread",
  );
  if (!labels.some((label) => label.toLowerCase() === "read")) {
    labels.push("read");
  }
  return { ...email, read: true, labels };
}

function replaceEmail<T extends EmailSummary>(
  emails: T[] | undefined,
  id: string,
  replacement: T,
): T[] | undefined {
  return emails?.map((email) => (email.id === id ? replacement : email));
}

function restoreCachedEmail(
  cache: MailCache | undefined,
  location: CachedEmailLocation,
): MailCache | undefined {
  if (!cache || findCachedEmail(cache, location.email.id)) return cache;
  const page = cache.pages[location.pageIndex];
  if (!page) return cache;
  const items = [...page.items];
  items.splice(Math.min(location.itemIndex, items.length), 0, location.email);
  return {
    ...cache,
    pages: cache.pages.map((current, pageIndex) =>
      pageIndex === location.pageIndex ? { ...current, items } : current,
    ),
  };
}

function hideArchivedEmail(qc: QueryClient, id: string) {
  qc.setQueryData<string[]>(HIDDEN_ARCHIVE_IDS_KEY, (old = []) =>
    old.includes(id) ? old : [...old, id],
  );
}

function showArchivedEmail(qc: QueryClient, id: string) {
  qc.setQueryData<string[]>(HIDDEN_ARCHIVE_IDS_KEY, (old = []) =>
    old.filter((hiddenId) => hiddenId !== id),
  );
}

/**
 * Vault-backed inbox list. Reads bounded frontmatter-only pages;
 * the watcher's path-routed invalidator (vault-events.ts) flips the
 * `["emails"]` key whenever inbox/ files land or change.
 */
export function useMail() {
  const { data, ...query } = useInfiniteQuery({
    queryKey: ["emails"],
    queryFn: ({ pageParam }) => mailInboxPage(pageParam, 200),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
  const { data: hiddenArchiveIds = EMPTY_ARCHIVE_IDS } = useQuery<string[]>({
    queryKey: HIDDEN_ARCHIVE_IDS_KEY,
    queryFn: () => Promise.resolve([]),
    initialData: EMPTY_ARCHIVE_IDS,
    enabled: false,
    gcTime: Infinity,
  });
  const visibleData = useMemo(() => {
    if (!data) return undefined;
    const hiddenIds = new Set(hiddenArchiveIds);
    return data.pages
      .flatMap((page) => page.items)
      .filter((email) => !hiddenIds.has(email.id));
  }, [data, hiddenArchiveIds]);
  return {
    ...query,
    data: visibleData,
  };
}

/** Consumers that genuinely aggregate the entire inbox (Sweep, person
 * activity, cross-message navigation) opt into walking every bounded page.
 * Ordinary inbox rendering remains user-driven and fetches one page at a time.
 */
export function useAllMail() {
  const query = useMail();
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  return query;
}

/**
 * Single email by id from disk. Returns `undefined` while loading,
 * `null` when no matching file exists.
 */
export function useEmail(id: string | null | undefined) {
  return useQuery<EmailSummary | null>({
    queryKey: ["email", id],
    queryFn: () => (id ? mailGetLocalRouteId(id) : Promise.resolve(null)),
    enabled: !!id,
  });
}

async function mailGetLocalRouteId(id: string): Promise<EmailSummary | null> {
  const direct = await mailGetLocal(id);
  if (direct || !id.includes("%")) return direct;

  // Older builds manually encoded ids before handing them to TanStack
  // Router, which encoded the percent signs a second time. Keep those
  // URLs/tabs readable, but prefer the direct id so literal percent
  // sequences in a message-id still resolve correctly.
  try {
    const decoded = decodeURIComponent(id);
    return decoded === id ? direct : await mailGetLocal(decoded);
  } catch {
    return direct;
  }
}

/**
 * Full message (summary + to/cc) for a single message, read from disk.
 * Lazy by design: pass `enabled: false` when the recipient list isn't on
 * screen so an expanded thread doesn't load every message eagerly.
 */
export function useEmailFull(
  id: string | null | undefined,
  inboxId: string | null | undefined,
  enabled: boolean,
) {
  return useQuery<EmailFull | null>({
    queryKey: ["email-full", id, inboxId ?? null],
    queryFn: () => (id ? mailGetFull(id) : Promise.resolve(null)),
    enabled: !!id && enabled,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * The Gmail accounts the user has connected. Loaded once and reused for
 * the unified inbox color dots, the from-inbox picker on compose, and the
 * inbox filter dropdown.
 */
export function useInboxes() {
  return useQuery<Inbox[]>({
    queryKey: ["mail-inboxes"],
    queryFn: () => inboxesList(),
    // Accounts change rarely (configured once in Settings). 5min stale-time
    // keeps us off the round-trip on every navigation.
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Imperative refresh hook. Hits Gmail for the latest N messages, persists
 * them as `inbox/*.md`, and invalidates `["emails"]` so the UI re-reads
 * from disk. Returns the sync result for the toolbar's "20 emails · 1.4s"
 * line.
 */
export function useRefreshMail() {
  const qc = useQueryClient();
  return async (limit = 20, inboxId?: string): Promise<MailSyncResult> => {
    // mailSyncRecentMulti syncs all Gmail accounts when inboxId is
    // undefined, or just the one named `gmail:...` account.
    const result = await mailSyncRecentMulti(limit, inboxId);
    qc.invalidateQueries({ queryKey: ["emails"] });
    return result;
  };
}

/**
 * All locally-persisted messages with the same thread id, oldest-first.
 * Drives the thread view on the email detail page.
 */
export function useThread(threadId: string | null | undefined) {
  return useQuery<EmailSummary[]>({
    queryKey: ["thread", threadId],
    queryFn: () => (threadId ? mailThread(threadId) : Promise.resolve([])),
    enabled: !!threadId,
  });
}

/**
 * Mark a message read. The cache flips synchronously so the unread dot
 * clears the moment the user opens the email; the IMAP/HTTP roundtrip
 * (~500–2000ms) runs in the background. The list isn't refetched on
 * success — the optimistic update is the correct end state, and bulk
 * mark-reads would otherwise thrash the list with mid-flight refetches.
 * On error we restore the previous cache.
 *
 * Short-circuits when no cached copy remains unread, so the inbox-open action
 * and the detail-view fallback can safely overlap without duplicate remote
 * calls or unnecessary cache writes.
 */
export function useMarkRead() {
  const qc = useQueryClient();
  return useCallback(
    async (id: string) => {
      const previousList = qc.getQueryData<MailCache>(["emails"]);
      const previousOne = qc.getQueryData<EmailSummary | null>(["email", id]);
      const previousListEmail = findCachedEmail(previousList, id)?.email;
      const previousThreads = qc
        .getQueriesData<EmailSummary[]>({ queryKey: ["thread"] })
        .flatMap(([queryKey, messages]) => {
          const email = messages?.find(
            (candidate) => candidate.id === id && !candidate.read,
          );
          return email ? [[queryKey, email] as const] : [];
        });
      const previousFullMessages = qc
        .getQueriesData<EmailFull | null>({ queryKey: ["email-full", id] })
        .flatMap(([queryKey, email]) =>
          email?.id === id && !email.read ? [[queryKey, email] as const] : [],
        );
      const listNeedsUpdate = previousListEmail
        ? !previousListEmail.read
        : false;
      const oneNeedsUpdate = previousOne ? !previousOne.read : false;
      if (
        !listNeedsUpdate &&
        !oneNeedsUpdate &&
        previousThreads.length === 0 &&
        previousFullMessages.length === 0
      ) {
        return;
      }

      if (listNeedsUpdate) {
        qc.setQueryData<MailCache | undefined>(["emails"], (old) =>
          updateCachedEmails(old, (email) =>
            email.id === id ? asRead(email) : email,
          ),
        );
      }
      if (oneNeedsUpdate) {
        qc.setQueryData<EmailSummary | null | undefined>(
          ["email", id],
          (old) => (old ? asRead(old) : old),
        );
      }
      for (const [queryKey] of previousThreads) {
        qc.setQueryData<EmailSummary[] | undefined>(queryKey, (old) =>
          old?.map((email) => (email.id === id ? asRead(email) : email)),
        );
      }
      for (const [queryKey] of previousFullMessages) {
        qc.setQueryData<EmailFull | null | undefined>(queryKey, (old) =>
          old ? asRead(old) : old,
        );
      }
      try {
        await mailMarkRead(id);
        // A full-message read may have started before the optimistic update.
        // Refresh it from the now-updated local record instead of retaining a
        // stale unread copy for its five-minute stale window.
        void qc.invalidateQueries({ queryKey: ["email-full", id] });
      } catch (e) {
        if (previousListEmail) {
          qc.setQueryData<MailCache | undefined>(["emails"], (old) =>
            updateCachedEmails(old, (email) =>
              email.id === id ? previousListEmail : email,
            ),
          );
        }
        if (previousOne !== undefined)
          qc.setQueryData(["email", id], previousOne);
        for (const [queryKey, previousThreadEmail] of previousThreads) {
          qc.setQueryData<EmailSummary[] | undefined>(queryKey, (old) =>
            replaceEmail(old, id, previousThreadEmail),
          );
        }
        for (const [queryKey, previousFullMessage] of previousFullMessages) {
          qc.setQueryData<EmailFull | null | undefined>(queryKey, (old) =>
            old?.id === id ? previousFullMessage : old,
          );
        }
        throw e;
      }
    },
    [qc],
  );
}

/**
 * Archive one message. The inbox list updates synchronously so `e` feels
 * instant; the IMAP/HTTP archive runs before local persistence completes.
 * We deliberately skip invalidating ["emails"] on success — the optimistic filter is the
 * correct end state, and bulk archive (`e` on a multi-selection) would
 * otherwise re-fetch the list mid-flight and flash siblings back into
 * view while their own archives are still pending. A separate hidden-id cache
 * keeps each pending archive out of the rendered list even if navigation or a
 * watcher refetch briefly returns the old inbox file. Once persistence finishes,
 * cancel any late read, reapply the cache filter, and then clear the hidden id.
 * On error, restore only this message so concurrent successful archives stay
 * removed.
 */
export function useArchiveOne() {
  const qc = useQueryClient();
  return async (id: string) => {
    const cancelExistingReads = qc.cancelQueries({
      queryKey: ["emails"],
      exact: true,
    });
    const previousList = qc.getQueryData<MailCache>(["emails"]);
    const previousEmail = findCachedEmail(previousList, id);
    hideArchivedEmail(qc, id);
    qc.setQueryData<MailCache | undefined>(["emails"], (old) =>
      updateCachedEmails(old, (email) => (email.id === id ? null : email)),
    );
    const archiveRequest = mailArchiveOne(id);
    try {
      await cancelExistingReads;
      await archiveRequest;
      await qc.cancelQueries({ queryKey: ["emails"], exact: true });
      qc.setQueryData<MailCache | undefined>(["emails"], (old) =>
        updateCachedEmails(old, (email) => (email.id === id ? null : email)),
      );
      showArchivedEmail(qc, id);
      qc.invalidateQueries({ queryKey: ["email", id] });
      qc.invalidateQueries({ queryKey: ["thread"] });
    } catch (e) {
      if (previousEmail) {
        qc.setQueryData<MailCache | undefined>(["emails"], (old) =>
          restoreCachedEmail(old, previousEmail),
        );
      }
      showArchivedEmail(qc, id);
      throw e;
    }
  };
}

/** Delete one message's local file (the Gmail mailbox is untouched). */
export function useDeleteOne() {
  const qc = useQueryClient();
  return async (id: string) => {
    const previousList = qc.getQueryData<MailCache>(["emails"]);
    qc.setQueryData<MailCache | undefined>(["emails"], (old) =>
      updateCachedEmails(old, (email) => (email.id === id ? null : email)),
    );
    try {
      await mailDeleteOne(id);
      qc.invalidateQueries({ queryKey: ["email", id] });
      qc.invalidateQueries({ queryKey: ["thread"] });
    } catch (e) {
      if (previousList) qc.setQueryData(["emails"], previousList);
      throw e;
    }
  };
}

/**
 * Send a new message via Gmail (SMTP). Persists a copy under `sent/` and
 * invalidates the inbox + thread caches so the sent message appears in
 * any open thread view.
 */
export function useSendMail() {
  const qc = useQueryClient();
  return async (input: ComposeInput): Promise<SendResult> => {
    const result = await mailSend(input);
    if (!result) throw new Error("send returned no result");
    qc.invalidateQueries({ queryKey: ["emails"] });
    qc.invalidateQueries({ queryKey: ["thread"] });
    return result;
  };
}

/**
 * Reply to an existing message. Same persistence and invalidation as
 * useSendMail, with the addition of a thread-specific invalidation so
 * the open thread view picks up the new message immediately.
 */
export function useReplyMail() {
  const qc = useQueryClient();
  return async (input: ReplyInput): Promise<SendResult> => {
    const result = await mailReply(input);
    if (!result) throw new Error("reply returned no result");
    qc.invalidateQueries({ queryKey: ["emails"] });
    qc.invalidateQueries({ queryKey: ["thread", input.threadId] });
    qc.invalidateQueries({ queryKey: ["thread"] });
    return result;
  };
}

/** Save (or update) a draft. Returns the persisted DTO with its id. */
export function useSaveDraft() {
  const qc = useQueryClient();
  return async (input: DraftSaveInput): Promise<DraftDto> => {
    const result = await mailDraftSave(input);
    if (!result) throw new Error("draft save returned no result");
    qc.invalidateQueries({ queryKey: ["drafts"] });
    return result;
  };
}

/** Delete a draft by id. Idempotent — silently no-ops if missing. */
export function useDeleteDraft() {
  const qc = useQueryClient();
  return async (id: string) => {
    await mailDraftDelete(id);
    qc.invalidateQueries({ queryKey: ["drafts"] });
  };
}
