import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  Mail as MailIcon,
  Link as LinkIcon,
  Pencil,
  RefreshCw,
  Search,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useListPanel } from "@/components/layout/list-panel-context-internal";
import {
  useArchiveOne,
  useInboxes,
  useMail,
  useRefreshMail,
} from "@/lib/hooks/use-mail";
import type {
  EmailSummary,
  Inbox,
  SyncStats,
} from "@/lib/mail-lib/types";
import { useAllPeople, type PersonDto } from "@/lib/hooks/use-people";
import { findPersonForMailSender } from "@/lib/mail-lib/people";
import { isEditableElement } from "@/lib/dom/is-editable";
import { ComposeDialog } from "@/components/mail/compose-dialog";
import { MailModeToggle } from "@/components/mail/mail-mode-toggle";

const ALL_INBOXES = "__all__";

export function MailInbox() {
  const navigate = useNavigate();
  const { collapsed } = useListPanel();
  const {
    data: emails = [],
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMail();
  const { data: inboxes = [], isLoading: inboxesLoading } = useInboxes();
  const { data: people = [] } = useAllPeople();
  const archiveOne = useArchiveOne();
  const [filterInbox, setFilterInbox] = useState<string>(ALL_INBOXES);
  const [composeOpen, setComposeOpen] = useState(false);

  const visibleThreads = useMemo(() => {
    const filtered =
      filterInbox === ALL_INBOXES
        ? emails
        : emails.filter((e) => e.inbox === filterInbox);
    return collapseMailThreads(filtered);
  }, [emails, filterInbox]);

  // Raw cursor is monotonic from user input; the rendered cursor clamps
  // into range at render time so a shrinking list (refresh, filter change)
  // auto-corrects without a setState-in-effect.
  const [rawCursor, setCursor] = useState(0);
  const cursor =
    visibleThreads.length === 0
      ? 0
      : Math.min(rawCursor, visibleThreads.length - 1);
  const rowRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  // Multi-select for bulk archive. `a` toggles select-all of currently-
  // visible threads; `e` archives the selection (or the cursor row when
  // no selection exists, preserving the single-archive shortcut). Esc
  // clears. We keep this as a Set keyed by thread id rather than indices
  // because filter changes / refreshes would invalidate index-based
  // selection silently. Each selected thread expands back to all of its
  // inbox message ids when archived.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Drop selection entries that aren't in the visible list anymore (e.g.
  // after a filter change). Without this, archive-selected would target
  // ids the user can't see.
  const liveSelected = useMemo(() => {
    if (selected.size === 0) return selected;
    const visibleIds = new Set(visibleThreads.map((thread) => thread.threadId));
    const next = new Set<string>();
    for (const id of selected) if (visibleIds.has(id)) next.add(id);
    return next.size === selected.size ? selected : next;
  }, [selected, visibleThreads]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && isEditableElement(target)) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(visibleThreads.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter") {
        const next = visibleThreads[cursor]?.email;
        if (!next) return;
        e.preventDefault();
        void navigate({
          to: "/mail/$id",
          params: { id: next.id },
        });
      } else if (e.key === "e" || e.key === "E") {
        // Archive — Superhuman / Gmail convention. If there's a multi-
        // selection, archive every selected thread; otherwise archive
        // the focused row.
        e.preventDefault();
        const threadsToArchive =
          liveSelected.size > 0
            ? visibleThreads.filter((thread) =>
                liveSelected.has(thread.threadId),
              )
            : visibleThreads[cursor]
              ? [visibleThreads[cursor]]
              : [];
        const ids = threadsToArchive.flatMap(
          (thread) => thread.messageIds,
        );
        if (ids.length === 0) return;
        // Optimistic clear of selection — feels snappier and matches
        // user intent (the selection just got actioned).
        setSelected(new Set());
        Promise.allSettled(ids.map((id) => archiveOne(id))).then((results) => {
          const failures = results.filter((r) => r.status === "rejected");
          if (failures.length > 0) {
            console.error(
              `archive failed for ${failures.length}/${ids.length} messages`,
              failures,
            );
          }
        });
      } else if (e.key === "a" || e.key === "A") {
        // Toggle select-all of visible. Empty list = no-op.
        e.preventDefault();
        if (visibleThreads.length === 0) return;
        const allIds = visibleThreads.map((thread) => thread.threadId);
        const allCurrentlySelected =
          liveSelected.size === allIds.length &&
          allIds.every((id) => liveSelected.has(id));
        setSelected(allCurrentlySelected ? new Set() : new Set(allIds));
      } else if (e.key === "Escape") {
        if (liveSelected.size > 0) {
          e.preventDefault();
          setSelected(new Set());
        }
      } else if (e.key === "c" || e.key === "C") {
        // Compose — Gmail convention.
        e.preventDefault();
        setComposeOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visibleThreads, cursor, navigate, archiveOne, liveSelected]);

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const activeEmail = visibleThreads[cursor]?.email;
  const detailPanelWidthClass = "w-[300px]";
  const unreadCount = useMemo(
    () => visibleThreads.filter((thread) => !thread.email.read).length,
    [visibleThreads],
  );

  return (
    <div className="flex-1 flex h-full min-w-0">
      {!collapsed && (
        <aside
          data-woodshed-surface="mail-detail-list"
          className={`${detailPanelWidthClass} shrink-0 bg-list flex flex-col border-r border-border`}
        >
          <div className="shrink-0 border-b border-border/45 px-3 pb-2.5 pt-3.5 dark:border-white/[0.07]">
            <MailModeToggle mode="inbox" />
          </div>
          {activeEmail ? (
            <EmailDetailPane email={activeEmail} people={people} />
          ) : null}
        </aside>
      )}

      <div className="flex-1 flex flex-col bg-content min-w-0">
        <ScrollArea className="flex-1">
          <div className="px-8 py-6">
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-xl font-semibold flex items-baseline gap-2">
                Inbox
                {unreadCount > 0 && (
                  <span className="text-muted-foreground text-base font-normal">
                    {unreadCount}
                  </span>
                )}
                {liveSelected.size > 0 && (
                  <span className="text-violet-500 text-[12px] font-normal">
                    {liveSelected.size} selected
                    <span className="text-muted-foreground/70 ml-1.5">
                      · e to archive · esc to clear
                    </span>
                  </span>
                )}
              </h1>
              <div className="flex items-center gap-2 text-muted-foreground">
                {inboxes.length > 1 && (
                  <InboxFilter
                    inboxes={inboxes}
                    value={filterInbox}
                    onChange={setFilterInbox}
                  />
                )}
                <SyncRefreshButton
                  inboxId={
                    filterInbox === ALL_INBOXES ? undefined : filterInbox
                  }
                />
                <button
                  type="button"
                  aria-label="Compose"
                  title="Compose (c)"
                  onClick={() => setComposeOpen(true)}
                  className="p-1.5 rounded hover:bg-foreground/[0.06] hover:text-foreground transition-colors"
                >
                  <Pencil className="h-4 w-4" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label="Search"
                  className="p-1.5 rounded hover:bg-foreground/[0.06] hover:text-foreground transition-colors"
                >
                  <Search className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>
            </div>

            {visibleThreads.length === 0 ? (
              <EmptyInbox
                isLoading={isLoading || inboxesLoading}
                hasInboxes={inboxes.length > 0}
              />
            ) : (
              <div className="space-y-px">
                {visibleThreads.map((thread, idx) => (
                  <EmailRow
                    key={thread.threadId}
                    email={thread.email}
                    messageCount={thread.messageIds.length}
                    people={people}
                    isCursor={idx === cursor}
                    isSelected={liveSelected.has(thread.threadId)}
                    onClick={() => setCursor(idx)}
                    ref={(el) => {
                      rowRefs.current[idx] = el;
                    }}
                  />
                ))}
                {hasNextPage && (
                  <button
                    type="button"
                    className="mt-3 w-full rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-50"
                    disabled={isFetchingNextPage}
                    onClick={() => void fetchNextPage()}
                  >
                    {isFetchingNextPage ? "Loading older mail…" : "Load older mail"}
                  </button>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {composeOpen && (
        <ComposeDialog
          open
          mode={{
            kind: "new",
            defaultFromInbox:
              filterInbox === ALL_INBOXES ? undefined : filterInbox,
          }}
          onClose={() => setComposeOpen(false)}
        />
      )}
    </div>
  );
}

interface EmailRowProps {
  email: EmailSummary;
  messageCount: number;
  people: PersonDto[];
  isCursor: boolean;
  isSelected: boolean;
  onClick: () => void;
  ref?: React.Ref<HTMLAnchorElement>;
}

function EmailRow({
  email,
  messageCount,
  people,
  isCursor,
  isSelected,
  onClick,
  ref,
}: EmailRowProps) {
  // Selected wins over cursor visually — the multi-selection is the
  // active intent. A 3px violet left bar marks selection so users can
  // scan the column at a glance.
  const bgClass = isSelected
    ? "bg-violet-500/[0.10]"
    : isCursor
      ? "bg-violet-500/[0.05]"
      : "hover:bg-foreground/[0.025]";
  const senderPerson = findPersonForMailSender(people, email);
  const senderName = senderPerson?.name ?? email.from;
  return (
    <Link
      to="/mail/$id"
      params={{ id: email.id }}
      ref={ref}
      data-mail-thread-row
      onClick={onClick}
      className={`relative flex items-center gap-4 pl-4 pr-3 py-2.5 rounded-md cursor-pointer transition-colors ${bgClass}`}
    >
      {isSelected && (
        <span
          aria-hidden
          className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-sm bg-violet-500"
        />
      )}
      {isCursor && (
        <span
          aria-hidden
          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-violet-500/40"
        />
      )}
      <div className="w-2 shrink-0 flex items-center justify-center">
        {!email.read && (
          <span className="block h-1.5 w-1.5 rounded-full bg-blue-500" />
        )}
      </div>
      <div className="w-[160px] shrink-0 truncate text-sm font-medium">
        {senderName}
      </div>
      <div className="flex-1 min-w-0 flex items-baseline gap-2 overflow-hidden">
        <span className="text-sm font-medium truncate shrink-0 max-w-[45%]">
          {email.subject}
        </span>
        {messageCount > 1 && (
          <span className="text-xs text-muted-foreground shrink-0">
            {messageCount}
          </span>
        )}
        <span className="text-sm text-muted-foreground truncate">
          {email.preview}
        </span>
      </div>
      <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
        {formatRelativeDate(email.date)}
      </span>
    </Link>
  );
}

interface MailThread {
  threadId: string;
  email: EmailSummary;
  messageIds: string[];
}

function collapseMailThreads(emails: EmailSummary[]): MailThread[] {
  const threads = new Map<string, MailThread>();
  for (const email of emails) {
    const threadId = email.threadId || email.id;
    const existing = threads.get(threadId);
    if (!existing) {
      threads.set(threadId, {
        threadId,
        email,
        messageIds: [email.id],
      });
      continue;
    }

    existing.messageIds.push(email.id);
    const anyUnread = !existing.email.read || !email.read;
    if (
      new Date(email.date).getTime() >
      new Date(existing.email.date).getTime()
    ) {
      existing.email = { ...email, read: !anyUnread };
    } else if (anyUnread && existing.email.read) {
      existing.email = { ...existing.email, read: false };
    }
  }

  return Array.from(threads.values()).sort(
    (a, b) =>
      new Date(b.email.date).getTime() - new Date(a.email.date).getTime(),
  );
}

function EmailDetailPane({
  email,
  people,
}: {
  email: EmailSummary;
  people: PersonDto[];
}) {
  const senderPerson = findPersonForMailSender(people, email);
  const senderName = senderPerson?.name ?? email.from;
  const senderEmail = senderPerson?.email ?? email.fromEmail;

  // Plain `overflow-y-auto` instead of <ScrollArea> — the summary pane
  // is purely informational, so it shouldn't appear in the tab order
  // (a plain div isn't keyboard-focusable, Base UI's ScrollArea Viewport
  // is).
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-5 py-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold leading-snug">{senderName}</h2>
          <div className="text-xs text-muted-foreground mt-0.5 break-all">
            {senderEmail}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
            <MailIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span className="font-medium text-foreground">Mail</span>
            {!email.read && (
              <span
                aria-label="Unread"
                title="Unread"
                className="ml-auto inline-block h-2 w-2 rounded-full bg-blue-500"
              />
            )}
          </div>
          <div className="text-sm font-medium leading-snug">{email.subject}</div>
          <div className="text-[13px] text-muted-foreground mt-1 leading-snug line-clamp-3">
            {email.preview}
          </div>
          <div className="text-[11px] text-muted-foreground mt-2 font-mono">
            {new Date(email.date).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            })}
          </div>
        </div>

        {visibleSidebarLinks(email.links).length > 0 && (
          <div className="space-y-1">
            {visibleSidebarLinks(email.links).map((link) => (
              <div
                key={link}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <LinkIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{link}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function visibleSidebarLinks(links: string[]) {
  const seen = new Set<string>();
  const useful = links.filter((link) => {
    if (seen.has(link)) return false;
    seen.add(link);
    return !isNoisySidebarLink(link);
  });
  return useful.slice(0, 5);
}

function isNoisySidebarLink(link: string) {
  try {
    const url = new URL(link);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "media.beehiiv.com") return true;
    if (url.pathname.includes("/cdn-cgi/")) return true;
    if (/\.(gif|jpe?g|png|webp|avif|svg)$/i.test(url.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Inbox filter dropdown. Only renders when more than one Gmail account is
 * configured. Single-inbox users don't need a noisy "All inboxes" UI.
 */
function InboxFilter({
  inboxes,
  value,
  onChange,
}: {
  inboxes: Inbox[];
  value: string;
  onChange: (next: string) => void;
}) {
  const current = inboxes.find((i) => i.inboxId === value);
  return (
    <div className="relative">
      <select
        aria-label="Filter by inbox"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none pl-2 pr-7 py-1 rounded text-xs bg-transparent border border-border hover:bg-foreground/[0.04] text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      >
        <option value={ALL_INBOXES}>All inboxes</option>
        {inboxes.map((i) => (
          <option key={i.inboxId} value={i.inboxId}>
            {i.displayName ?? i.email}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2"
      >
        <ChevronDown className="h-3 w-3" strokeWidth={1.75} />
      </span>
      {value !== ALL_INBOXES && current && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 sr-only"
        >
          {current.email}
        </span>
      )}
    </div>
  );
}

function EmptyInbox({
  isLoading,
  hasInboxes,
}: {
  isLoading: boolean;
  hasInboxes: boolean;
}) {
  // Stay blank during initial load so the no-inboxes setup screen
  // doesn't flash for users who do have inboxes — the inboxes query
  // returns [] until it resolves.
  if (isLoading) return null;
  if (!hasInboxes) {
    return (
      <div className="py-12 text-center space-y-3">
        <p className="text-sm text-muted-foreground">No mail accounts yet.</p>
        <p className="text-[13px] text-muted-foreground max-w-[480px] mx-auto">
          Connect Gmail (IMAP + App Password) in{" "}
          <Link
            to="/settings/accounts"
            className="text-foreground underline underline-offset-2 hover:no-underline"
          >
            Settings
          </Link>
          . Your account shows up here as soon as you paste your App
          Password.
        </p>
      </div>
    );
  }
  return (
    <div className="py-12 text-center space-y-3">
      <p className="text-sm text-muted-foreground">No emails synced yet.</p>
      <p className="text-[13px] text-muted-foreground">
        Click <span className="font-medium text-foreground">Refresh</span> to
        pull from your connected accounts.
      </p>
    </div>
  );
}

function formatRelativeDate(dateStr: string) {
  const date = new Date(dateStr);
  const today = new Date();
  const diffMs = today.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "1 week ago";
  return `${Math.floor(diffDays / 7)} weeks ago`;
}

function formatSyncSummary(count: number, stats: SyncStats): string {
  const seconds = (stats.durationMs / 1000).toFixed(
    stats.durationMs < 10_000 ? 1 : 0,
  );
  return `${count} email${count === 1 ? "" : "s"} · ${seconds}s`;
}

function SyncRefreshButton({ inboxId }: { inboxId: string | undefined }) {
  const refresh = useRefreshMail();
  const [status, setStatus] = useState<"idle" | "syncing" | "ok" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setStatus("syncing");
    setMessage(null);
    try {
      const { emails, stats } = await refresh(20, inboxId);
      setStatus("ok");
      setMessage(formatSyncSummary(emails.length, stats));
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  const tooltip =
    status === "syncing"
      ? "Syncing…"
      : message ?? "Refresh mail (all providers)";

  return (
    <div className="flex items-center gap-1.5 relative">
      {status === "ok" && message && (
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {message}
        </span>
      )}
      {status === "error" && message && (
        <details className="text-[11px] text-red-500">
          <summary className="cursor-pointer select-none">
            Sync failed — details
          </summary>
          <pre className="absolute right-0 top-7 z-10 max-w-[480px] whitespace-pre-wrap break-words rounded-md border border-border bg-popover p-2 font-mono text-[11px] text-foreground shadow-lg">
            {message}
          </pre>
        </details>
      )}
      <button
        type="button"
        aria-label="Refresh"
        title={tooltip}
        disabled={status === "syncing"}
        onClick={handleClick}
        className="p-1.5 rounded hover:bg-foreground/[0.06] hover:text-foreground transition-colors disabled:opacity-50"
      >
        <RefreshCw
          className={`h-4 w-4 ${status === "syncing" ? "animate-spin" : ""}`}
          strokeWidth={1.75}
        />
      </button>
    </div>
  );
}
