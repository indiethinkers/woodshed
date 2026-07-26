"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";

export interface GcalAccountInfo {
  id: string;
  displayName: string;
  /** Hex color, e.g. "#FF6B6B". */
  color: string;
  /** Email addresses the user is known by on this calendar. Drives
   *  the sync's DECLINED + involvement filters; empty list disables
   *  filtering for this calendar (every parsed event is kept). */
  emails: string[];
  lastSyncedAt: string | null;
  /** Last sync error for this calendar, persisted across app restarts.
   *  Cleared automatically when a sync succeeds. */
  lastError: string | null;
  /** Count of locally dismissed events for this calendar. */
  dismissedCount: number;
}

export interface AccountSyncResult {
  accountId: string;
  written: number;
  deleted: number;
  /** Non-null when this account's fetch or parse failed. Other
   *  accounts in the same report still ran. */
  error: string | null;
}

export interface SyncReport {
  accounts: AccountSyncResult[];
}

export interface GcalAccountAddInput {
  url: string;
  displayName: string;
  color: string;
  /** Optional. Empty list = no filter (every event in the feed is
   *  surfaced). Frontend collects this as a comma-separated string
   *  and splits before passing through. */
  emails?: string[];
}

export interface GcalAccountUpdateInput {
  accountId: string;
  displayName?: string;
  color?: string;
  emails?: string[];
}

export function useGcalSync(): UseMutationResult<
  SyncReport,
  Error,
  { accountId?: string } | void
> {
  const qc = useQueryClient();
  return useMutation<SyncReport, Error, { accountId?: string } | void>({
    mutationFn: async (vars) => {
      const accountId = vars && "accountId" in vars ? vars.accountId : null;
      const result = await tauriInvoke<SyncReport>("gcal_ical_sync", {
        accountId: accountId ?? null,
      });
      if (!result) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      // The watcher already invalidates ["events"] for each file the
      // sync writes — this is belt-and-suspenders for the case where
      // self-write fingerprinting swallowed the event.
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["gcal", "accounts"] });
      return result;
    },
  });
}

/**
 * Fire a non-blocking sync on Cadence date page mount. Page content
 * renders immediately from the existing `useEvents(date)` query; new
 * events from the iCal feed appear when the watcher invalidates the
 * query a moment later.
 */
/** Trigger a sync for a specific calendar from the settings UI. */
export function useGcalSyncOne(): UseMutationResult<
  SyncReport,
  Error,
  { accountId: string }
> {
  const qc = useQueryClient();
  return useMutation<SyncReport, Error, { accountId: string }>({
    mutationFn: async ({ accountId }) => {
      const result = await tauriInvoke<SyncReport>("gcal_ical_sync", {
        accountId,
      });
      if (!result) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["gcal", "accounts"] });
      return result;
    },
  });
}

export function useGcalAccounts(): UseQueryResult<GcalAccountInfo[]> {
  return useQuery<GcalAccountInfo[]>({
    queryKey: ["gcal", "accounts"],
    queryFn: async () => {
      const result = await tauriInvoke<GcalAccountInfo[]>("gcal_accounts_list");
      return result ?? [];
    },
  });
}

export function useGcalAccountMutations(): {
  add: UseMutationResult<GcalAccountInfo, Error, GcalAccountAddInput>;
  update: UseMutationResult<GcalAccountInfo, Error, GcalAccountUpdateInput>;
  remove: UseMutationResult<void, Error, { accountId: string }>;
} {
  const qc = useQueryClient();

  const add = useMutation<GcalAccountInfo, Error, GcalAccountAddInput>({
    mutationFn: async (input) => {
      const result = await tauriInvoke<GcalAccountInfo>("gcal_account_add", {
        input: {
          url: input.url,
          displayName: input.displayName,
          color: input.color,
          emails: input.emails ?? [],
        },
      });
      if (!result) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      // Initial sync runs server-side as part of add — refresh both
      // the accounts list (new row appears) and the events list (new
      // events appear immediately rather than waiting for a 2nd sync).
      qc.invalidateQueries({ queryKey: ["gcal", "accounts"] });
      qc.invalidateQueries({ queryKey: ["events"] });
      return result;
    },
  });

  const update = useMutation<GcalAccountInfo, Error, GcalAccountUpdateInput>({
    mutationFn: async (input) => {
      const result = await tauriInvoke<GcalAccountInfo>("gcal_account_update", {
        input,
      });
      if (!result) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.invalidateQueries({ queryKey: ["gcal", "accounts"] });
      return result;
    },
  });

  const remove = useMutation<void, Error, { accountId: string }>({
    mutationFn: async ({ accountId }) => {
      await tauriInvoke<void>("gcal_account_remove", { accountId });
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.invalidateQueries({ queryKey: ["gcal", "accounts"] });
      qc.invalidateQueries({ queryKey: ["events"] });
    },
  });

  return { add, update, remove };
}

/**
 * Dismiss one occurrence of an iCal event locally so it stops showing
 * up in cadence and tag tables on that specific date. Survives sync
 * (the dismissal lives on the account meta, not in the cache that
 * gets replaced wholesale every sync). Sibling occurrences of the
 * same recurring master — other Tuesdays/Thursdays of a Tue/Thu
 * meeting, future weeks of a weekly series — keep showing.
 *
 * `occurrenceDate` is the row's projected date, in `YYYY-MM-DD` or any
 * RFC 3339 form; only the date portion is stored. Doesn't touch the
 * source calendar — declining or deleting in Google Calendar is a
 * separate, manual action.
 */
export function useIcalEventDismiss(): UseMutationResult<
  void,
  Error,
  { accountId: string; externalId: string; occurrenceDate: string }
> {
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    { accountId: string; externalId: string; occurrenceDate: string }
  >({
    mutationFn: async ({ accountId, externalId, occurrenceDate }) => {
      await tauriInvoke<void>("event_ical_dismiss", {
        accountId,
        externalId,
        occurrenceDate,
      });
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["gcal", "accounts"] });
    },
    onMutate: async ({ accountId, externalId, occurrenceDate }) => {
      // Optimistic: drop the dismissed occurrence from every cached
      // events list so the row disappears immediately. Match on
      // (accountId, externalId, date) — sibling rows for the same
      // recurring master stay in the list.
      const wantDay = occurrenceDate.slice(0, 10);
      qc.getQueriesData<unknown[]>({ queryKey: ["events"] }).forEach(
        ([key, value]) => {
          if (!Array.isArray(value)) return;
          const next = (
            value as Array<{ accountId?: string; externalId?: string; date?: string }>
          ).filter(
            (e) =>
              !(
                e.accountId === accountId &&
                e.externalId === externalId &&
                (e.date ?? "").slice(0, 10) === wantDay
              ),
          );
          qc.setQueryData(key, next);
        },
      );
    },
    onError: () => {
      // Roll back the optimistic drop by refetching authoritative state.
      qc.invalidateQueries({ queryKey: ["events"] });
    },
  });
}
