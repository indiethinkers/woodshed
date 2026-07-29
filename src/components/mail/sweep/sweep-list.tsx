"use client";

import { RefreshCw } from "lucide-react";
import { LANES, rowsByLane } from "@/lib/sweep";
import {
  shouldShowUnreadIndicator,
  type EmailSummary,
} from "@/lib/mail-lib/types";
import type { SweepCard, SweepStatus } from "@/lib/sweep/types";
import type { SweepLaneRow } from "@/lib/sweep";
import type { MailRefreshProgress } from "@/lib/hooks/use-mail-refresh-job";
import { MailModeToggle } from "@/components/mail/mail-mode-toggle";

interface Props {
  emails: EmailSummary[];
  cards: SweepCard[];
  lane: SweepStatus;
  onLaneChange: (lane: SweepStatus) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  progress: MailRefreshProgress;
  processingIds: ReadonlySet<string>;
  triagingCount: number;
}

const SHORT_LABEL: Record<SweepStatus, string> = {
  to_review: "Review",
  queued: "Queued",
  working: "Working",
  done: "Done",
};

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function dotClass(row: SweepLaneRow): string {
  const { email, card } = row;
  if (card?.status === "done") return "bg-transparent";
  if (email && shouldShowUnreadIndicator(email)) return "bg-blue-500";
  // Sweep cards can outlive or lose their source email row. In that case
  // we do not have a provider read signal, so don't claim unread with blue.
  if (!email && card) return "bg-muted-foreground/25";
  if (!card) return "bg-muted-foreground/25";
  return "bg-muted-foreground/30";
}

function processingText(
  row: SweepLaneRow,
  progress: MailRefreshProgress,
  processingIds: ReadonlySet<string>,
): string | null {
  if (progress.phase === "syncing") return "loading";
  if (progress.phase !== "triaging" || row.card) return null;
  return processingIds.has(row.id) ? "triaging" : "queued";
}

export function SweepList(props: Props) {
  const rowsByStatus = rowsByLane(props.emails, props.cards);
  const counts: Record<SweepStatus, number> = {
    to_review: rowsByStatus.to_review.length,
    queued: rowsByStatus.queued.length,
    working: rowsByStatus.working.length,
    done: rowsByStatus.done.length,
  };
  const rows = rowsByStatus[props.lane];
  const showRefreshState =
    props.refreshing &&
    (props.progress.phase === "syncing" || props.progress.phase === "triaging");

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-border/45 bg-list dark:border-white/[0.07]">
        <div className="flex items-center justify-between px-3 pb-2.5 pt-3.5">
          <h1 className="sr-only">AI Sweep</h1>
          <MailModeToggle mode="sweep" />
          <button
            type="button"
            aria-label="Refresh and triage"
            title="Sync Gmail, then triage new mail with your configured Hermes agent"
            onClick={props.onRefresh}
            disabled={props.refreshing}
            className="flex items-center gap-1.5 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50 dark:hover:bg-white/[0.06]"
          >
            {props.triagingCount > 0 && (
              <span className="text-[11px] tabular-nums">
                {props.triagingCount}
              </span>
            )}
            <RefreshCw
              className={`h-4 w-4 ${props.refreshing ? "animate-spin" : ""}`}
              strokeWidth={1.75}
            />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-1 px-2 pb-2.5">
          {LANES.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => props.onLaneChange(l.id)}
              className={`rounded-md px-2 py-1.5 text-xs leading-tight transition-colors ${
                props.lane === l.id
                  ? "bg-foreground/[0.055] font-medium text-foreground shadow-[0_1px_0_rgba(255,255,255,0.45)_inset] dark:bg-white/[0.08] dark:shadow-none"
                  : "text-muted-foreground hover:bg-foreground/[0.035] hover:text-foreground dark:hover:bg-white/[0.045]"
              }`}
            >
              <span className="block truncate">{SHORT_LABEL[l.id]}</span>
              <span className="block tabular-nums opacity-65">{counts[l.id]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">
            {showRefreshState
              ? props.progress.phase === "syncing"
                ? "Loading inbox..."
                : "Motif is processing this lane..."
              : props.lane === "to_review"
                ? "Nothing to review."
                : "Nothing here."}
          </p>
        ) : (
          <ul>
            {rows.map((row) => {
              const { email, card } = row;
              const selected = row.id === props.selectedId;
              const rowProcessing =
                showRefreshState &&
                (props.progress.phase === "syncing" ||
                  props.processingIds.has(row.id) ||
                  (!row.card && props.progress.phase === "triaging"));
              const statusText = rowProcessing
                ? processingText(row, props.progress, props.processingIds)
                : null;
              const from = card?.from || email?.from || email?.fromEmail || "";
              const subject = card?.headline || email?.subject || "(no subject)";
              const preview = card?.summary || email?.preview || "";
              const date = card?.emailDate || email?.date || "";
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => props.onSelect(row.id)}
                    className={`relative flex w-full overflow-hidden border-b border-border/60 px-3 py-2.5 text-left transition-colors ${
                      selected
                        ? "bg-foreground/[0.06]"
                        : "hover:bg-foreground/[0.03]"
                    }`}
                  >
                    <div className="relative min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${dotClass(row)}`}
                        />
                        <span className="flex-1 truncate text-[13px] font-medium text-foreground">
                          {from}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatDate(date)}
                        </span>
                      </div>
                      <span className="block truncate pl-3.5 text-[13px] text-foreground/90">
                        {subject}
                      </span>
                      <span className="flex min-w-0 items-center gap-2 pl-3.5">
                        <span className="line-clamp-1 min-w-0 flex-1 text-xs text-muted-foreground">
                          {preview}
                        </span>
                        {statusText && (
                          <span className="shrink-0 rounded-full border border-border bg-foreground/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                            {statusText}
                          </span>
                        )}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
