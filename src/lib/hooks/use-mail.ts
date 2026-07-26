"use client";

import { useEffect } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
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
  MailSyncResult,
  ReplyInput,
  SendResult,
} from "@/lib/mail-lib/types";

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
  return {
    ...query,
    data: data?.pages.flatMap((page) => page.items),
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
 * Short-circuits when both caches already show `read: true`. This matters
 * because EmailDetail's auto-mark-read effect re-runs on every render
 * (markRead is a new function ref each time, and the ["thread"] cache
 * isn't part of the optimistic write — so the effect keeps seeing the
 * unread message in `messages` and calls back in). Without the early
 * return, every call would produce a new `["emails"]` array via `.map`,
 * which re-renders useMail, which re-renders EmailDetail — an infinite
 * loop that React caps with "Maximum update depth exceeded."
 */
export function useMarkRead() {
  const qc = useQueryClient();
  return async (id: string) => {
    const previousList = qc.getQueryData<EmailSummary[]>(["emails"]);
    const previousOne = qc.getQueryData<EmailSummary | null>(["email", id]);
    const listNeedsUpdate =
      previousList?.some((e) => e.id === id && !e.read) ?? false;
    const oneNeedsUpdate = previousOne ? !previousOne.read : false;
    if (!listNeedsUpdate && !oneNeedsUpdate) return;

    if (listNeedsUpdate) {
      qc.setQueryData<EmailSummary[] | undefined>(["emails"], (old) =>
        old?.map((e) => (e.id === id ? { ...e, read: true } : e)),
      );
    }
    if (oneNeedsUpdate) {
      qc.setQueryData<EmailSummary | null | undefined>(["email", id], (old) =>
        old ? { ...old, read: true } : old,
      );
    }
    try {
      await mailMarkRead(id);
    } catch (e) {
      if (previousList) qc.setQueryData(["emails"], previousList);
      if (previousOne !== undefined) qc.setQueryData(["email", id], previousOne);
      throw e;
    }
  };
}

/**
 * Archive one message. The inbox list updates synchronously so `e` feels
 * instant; the IMAP/HTTP archive runs before local persistence completes.
 * We deliberately
 * skip invalidating ["emails"] on success — the optimistic filter is the
 * correct end state, and bulk archive (`e` on a multi-selection) would
 * otherwise re-fetch the list mid-flight and flash siblings back into
 * view while their own archives are still pending. Reapply the filter once
 * persistence finishes because navigating to an empty inbox can trigger a
 * local-disk refetch before the command has moved the file. On error, restore
 * only this message so concurrent successful archives stay removed.
 */
export function useArchiveOne() {
  const qc = useQueryClient();
  return async (id: string) => {
    const previousList = qc.getQueryData<EmailSummary[]>(["emails"]);
    const previousEmail = previousList?.find((email) => email.id === id);
    const previousIndex = previousList?.findIndex((email) => email.id === id);
    qc.setQueryData<EmailSummary[] | undefined>(["emails"], (old) =>
      old?.filter((e) => e.id !== id),
    );
    try {
      await mailArchiveOne(id);
      // An empty-array cache is intentionally stale in Providers. Returning
      // to /mail while the remote archive is in flight can therefore re-read
      // the still-present inbox file. The completed command is authoritative.
      qc.setQueryData<EmailSummary[] | undefined>(["emails"], (old) =>
        old?.filter((e) => e.id !== id),
      );
      qc.invalidateQueries({ queryKey: ["email", id] });
      qc.invalidateQueries({ queryKey: ["thread"] });
    } catch (e) {
      if (previousEmail) {
        qc.setQueryData<EmailSummary[] | undefined>(["emails"], (old) => {
          if (!old || old.some((email) => email.id === id)) return old;
          const restored = [...old];
          restored.splice(
            Math.min(previousIndex ?? restored.length, restored.length),
            0,
            previousEmail,
          );
          return restored;
        });
      }
      throw e;
    }
  };
}

/** Delete one message's local file (the Gmail mailbox is untouched). */
export function useDeleteOne() {
  const qc = useQueryClient();
  return async (id: string) => {
    const previousList = qc.getQueryData<EmailSummary[]>(["emails"]);
    qc.setQueryData<EmailSummary[] | undefined>(["emails"], (old) =>
      old?.filter((e) => e.id !== id),
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
