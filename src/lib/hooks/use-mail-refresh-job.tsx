"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { mailSyncRecentMulti } from "@/lib/mail-lib";
import type { MailSyncResult } from "@/lib/mail-lib/types";
import {
  pendingEmailIds,
  runTriageQueue,
  sweepCardsAll,
  sweepDiscardOrphans,
  sweepTriageEmail,
} from "@/lib/sweep";
import type { SweepCard } from "@/lib/sweep/types";

interface RefreshInboxOptions {
  limit?: number;
  inboxId?: string;
}

export type MailRefreshPhase =
  | "idle"
  | "syncing"
  | "triaging"
  | "complete"
  | "error";

export interface MailRefreshProgress {
  phase: MailRefreshPhase;
  limit: number;
  loaded: number;
  alreadyTriaged: number;
  pending: number;
  triaged: number;
  failed: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface MailRefreshLogEntry {
  id: string;
  at: string;
  tone: "info" | "success" | "warning" | "error";
  message: string;
  detail?: string;
}

interface MailRefreshJobContextValue {
  refreshing: boolean;
  triagingIds: Set<string>;
  progress: MailRefreshProgress;
  logs: MailRefreshLogEntry[];
  refreshInbox: (options?: RefreshInboxOptions) => Promise<MailSyncResult>;
  dismissLog: () => void;
}

const MailRefreshJobContext =
  createContext<MailRefreshJobContextValue | null>(null);

function idleProgress(): MailRefreshProgress {
  return {
    phase: "idle",
    limit: 20,
    loaded: 0,
    alreadyTriaged: 0,
    pending: 0,
    triaged: 0,
    failed: 0,
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MailRefreshProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  const activePromiseRef = useRef<Promise<MailSyncResult> | null>(null);
  const logSeqRef = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const [triagingIds, setTriagingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [progress, setProgress] = useState<MailRefreshProgress>(idleProgress);
  const [logs, setLogs] = useState<MailRefreshLogEntry[]>([]);

  const appendLog = useCallback(
    (entry: Omit<MailRefreshLogEntry, "id" | "at">) => {
      const id = `mail-refresh-${Date.now()}-${++logSeqRef.current}`;
      const at = new Date().toISOString();
      setLogs((prev) => [...prev, { id, at, ...entry }].slice(-80));
    },
    [],
  );

  const dismissLog = useCallback(() => {
    if (activePromiseRef.current) return;
    setLogs([]);
    setProgress(idleProgress());
  }, []);

  const refreshInbox = useCallback(
    (options: RefreshInboxOptions = {}) => {
      if (activePromiseRef.current) return activePromiseRef.current;

      const promise = (async () => {
        const limit = options.limit ?? 20;
        const startedAt = new Date().toISOString();
        setRefreshing(true);
        setTriagingIds(new Set());
        setLogs([]);
        setProgress({
          ...idleProgress(),
          phase: "syncing",
          limit,
          startedAt,
        });
        appendLog({
          tone: "info",
          message: "Connecting to inbox providers",
          detail: `Loading up to ${limit} recent messages.`,
        });

        try {
          const result = await mailSyncRecentMulti(limit, options.inboxId);
          qc.invalidateQueries({ queryKey: ["emails"] });
          const loaded = result.emails.length;
          setProgress((prev) => ({ ...prev, loaded }));
          appendLog({
            tone: "success",
            message: `Checked ${formatEmailCount(loaded)}`,
            detail: `${Math.round(result.stats.durationMs)}ms sync time.`,
          });

          const removed = result.removed ?? 0;
          if (removed > 0) {
            appendLog({
              tone: "info",
              message: `Cleared ${formatEmailCount(removed)} already handled in Gmail`,
              detail: "These left your Gmail inbox, so they were archived here too.",
            });
          }

          // Drop stale Review cards whose source email is no longer in the
          // inbox (handled directly in Gmail in an earlier session). Keeps
          // the Review lane honest even for mail archived before this build.
          const orphans = await sweepDiscardOrphans().catch(() => 0);
          if (orphans > 0) {
            qc.invalidateQueries({ queryKey: ["sweep"] });
            appendLog({
              tone: "info",
              message: `Cleared ${orphans} stale ${orphans === 1 ? "card" : "cards"} from Review`,
              detail: "Their emails were already handled outside Woodshed.",
            });
          }

          const cards =
            qc.getQueryData<SweepCard[]>(["sweep"]) ?? (await sweepCardsAll());
          const pending = pendingEmailIds(result.emails, cards);
          const alreadyTriaged = Math.max(loaded - pending.length, 0);
          setProgress((prev) => ({
            ...prev,
            phase: pending.length > 0 ? "triaging" : "complete",
            alreadyTriaged,
            pending: pending.length,
            triaged: 0,
            failed: 0,
            completedAt:
              pending.length > 0 ? null : new Date().toISOString(),
          }));
          appendLog({
            tone: pending.length > 0 ? "info" : "success",
            message:
              pending.length > 0
                ? `Queued ${pending.length} for triage`
                : "No new mail added to the sweep",
            detail:
              alreadyTriaged > 0
                ? `${formatEmailCount(alreadyTriaged)} already in the sweep.`
                : undefined,
          });

          if (pending.length > 0) {
            const emailsById = new Map(result.emails.map((e) => [e.id, e]));
            let triaged = 0;
            let failed = 0;
            setTriagingIds(new Set(pending));
            await runTriageQueue(
              pending,
              async (id) => {
                const email = emailsById.get(id);
                try {
                  await sweepTriageEmail(id);
                  triaged += 1;
                  qc.invalidateQueries({ queryKey: ["sweep"] });
                  setProgress((prev) => ({
                    ...prev,
                    triaged,
                    failed,
                  }));
                  appendLog({
                    tone: "success",
                    message: `Triaged ${triaged} of ${pending.length}`,
                    detail: email?.subject || email?.from || id,
                  });
                } catch (error) {
                  failed += 1;
                  setProgress((prev) => ({
                    ...prev,
                    triaged,
                    failed,
                  }));
                  appendLog({
                    tone: "error",
                    message: `Could not triage ${failed} ${
                      failed === 1 ? "email" : "emails"
                    }`,
                    detail: errorMessage(error),
                  });
                } finally {
                  setTriagingIds((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                  });
                }
              },
              { concurrency: 3 },
            );
            setProgress((prev) => ({
              ...prev,
              phase: "complete",
              triaged,
              failed,
              completedAt: new Date().toISOString(),
            }));
            appendLog({
              tone: failed > 0 ? "warning" : "success",
              message:
                failed > 0
                  ? `Finished with ${failed} ${
                      failed === 1 ? "failure" : "failures"
                    }`
                  : "Refresh complete",
              detail: `${formatEmailCount(loaded)} checked, ${pending.length} new, ${triaged} triaged.`,
            });
          } else {
            appendLog({
              tone: "success",
              message: "Refresh complete",
              detail: `${formatEmailCount(loaded)} checked, 0 new.`,
            });
          }

          qc.invalidateQueries({ queryKey: ["sweep"] });
          return result;
        } catch (error) {
          const message = errorMessage(error);
          setProgress((prev) => ({
            ...prev,
            phase: "error",
            error: message,
            completedAt: new Date().toISOString(),
          }));
          appendLog({
            tone: "error",
            message: "Refresh failed",
            detail: message,
          });
          throw error;
        } finally {
          setRefreshing(false);
          setTriagingIds(new Set());
          activePromiseRef.current = null;
        }
      })();

      activePromiseRef.current = promise;
      return promise;
    },
    [appendLog, qc],
  );

  const value = useMemo(
    () => ({
      refreshing,
      triagingIds,
      progress,
      logs,
      refreshInbox,
      dismissLog,
    }),
    [dismissLog, logs, progress, refreshInbox, refreshing, triagingIds],
  );

  return (
    <MailRefreshJobContext.Provider value={value}>
      {children}
    </MailRefreshJobContext.Provider>
  );
}

export function useMailRefreshJob() {
  const context = useContext(MailRefreshJobContext);
  if (!context) {
    throw new Error("useMailRefreshJob must be used inside MailRefreshProvider");
  }
  return context;
}

function formatEmailCount(count: number): string {
  return `${count} ${count === 1 ? "email" : "emails"}`;
}
