import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  Mail as MailIcon,
  Link as LinkIcon,
  Pencil,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useListPanel } from "@/components/layout/list-panel-context-internal";
import {
  useArchiveOne,
  useDrafts,
  useInboxes,
  useMailFolder,
  useMarkRead,
  useRefreshMail,
} from "@/lib/hooks/use-mail";
import {
  shouldShowUnreadIndicator,
  type DraftDto,
  type EmailSummary,
  type Inbox,
  type MailFolder,
  type Mailbox,
  type SyncStats,
} from "@/lib/mail-lib/types";
import { useAllPeople, type PersonDto } from "@/lib/hooks/use-people";
import { findPersonForMailSender } from "@/lib/mail-lib/people";
import { isEditableElement } from "@/lib/dom/is-editable";
import { ComposeDialog } from "@/components/mail/compose-dialog";
import { SnoozeButton } from "@/components/mail/snooze-button";

const ALL_INBOXES = "__all__";
const MAILBOXES: { id: Mailbox; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "drafts", label: "Drafts" },
  { id: "sent", label: "Sent" },
  { id: "archive", label: "Archive" },
];

interface MailInboxProps {
  mailbox?: Mailbox;
}

export function MailInbox({ mailbox: routeMailbox }: MailInboxProps = {}) {
  const navigate = useNavigate();
  const { collapsed } = useListPanel();
  const [localMailbox, setLocalMailbox] = useState<Mailbox>("inbox");
  const mailbox = routeMailbox ?? localMailbox;
  const mailboxSearch = useMemo(
    () => (mailbox === "inbox" ? {} : { mailbox }),
    [mailbox],
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const folder: MailFolder = mailbox === "drafts" ? "inbox" : mailbox;
  const {
    data: emails = [],
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMailFolder(
    folder,
    mailbox === "drafts" ? "" : searchQuery,
    mailbox !== "drafts",
  );
  const { data: drafts = [], isLoading: draftsLoading } = useDrafts(
    mailbox === "drafts" ? searchQuery : "",
    mailbox === "drafts",
  );
  const { data: inboxes = [], isLoading: inboxesLoading } = useInboxes();
  const { data: people = [] } = useAllPeople();
  const archiveOne = useArchiveOne();
  const markRead = useMarkRead();
  const [filterInbox, setFilterInbox] = useState<string>(ALL_INBOXES);
  const [composeOpen, setComposeOpen] = useState(false);
  const [activeDraft, setActiveDraft] = useState<DraftDto | undefined>();
  const [rowFocused, setRowFocused] = useState(true);

  const visibleThreads = useMemo(() => {
    if (mailbox === "drafts") return [];
    const filtered =
      mailbox !== "inbox" || filterInbox === ALL_INBOXES
        ? emails
        : emails.filter((e) => e.inbox === filterInbox);
    return collapseMailThreads(filtered);
  }, [emails, filterInbox, mailbox]);

  function changeMailbox(next: Mailbox) {
    if (routeMailbox === undefined) setLocalMailbox(next);
    void navigate({
      to: "/mail",
      search: next === "inbox" ? {} : { mailbox: next },
      replace: true,
    });
    setCursor(0);
    setRowFocused(true);
    setSelected(new Set());
    setSearchQuery("");
  }

  // Raw cursor is monotonic from user input; the rendered cursor clamps
  // into range at render time so a shrinking list (refresh, filter change)
  // auto-corrects without a setState-in-effect.
  const [rawCursor, setCursor] = useState(0);
  const cursor =
    visibleThreads.length === 0
      ? 0
      : Math.min(rawCursor, visibleThreads.length - 1);
  const rowRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const mailRowFocused =
    rowFocused && mailbox !== "drafts" && visibleThreads.length > 0;

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

  const markThreadRead = useCallback(
    (thread: MailThread) => {
      if (thread.unreadMessageIds.length === 0) return;
      void Promise.allSettled(
        thread.unreadMessageIds.map((id) => markRead(id)),
      ).then((results) => {
        const failureCount = results.filter(
          (result) => result.status === "rejected",
        ).length;
        if (failureCount > 0) {
          console.error(
            `Mark read failed for ${failureCount} messages in the opened thread.`,
          );
        }
      });
    },
    [markRead],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && isEditableElement(target)) return;

      if (e.key === "ArrowDown") {
        if (visibleThreads.length === 0) return;
        e.preventDefault();
        setRowFocused(true);
        setCursor((c) => Math.min(visibleThreads.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        if (visibleThreads.length === 0) return;
        e.preventDefault();
        setRowFocused(true);
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter") {
        if (!mailRowFocused) return;
        const next = visibleThreads[cursor];
        if (!next) return;
        e.preventDefault();
        if (mailbox === "inbox") markThreadRead(next);
        void navigate({
          to: "/mail/$id",
          params: { id: next.email.id },
          search: mailboxSearch,
        });
      } else if (e.key === "e" || e.key === "E") {
        if (!mailRowFocused || mailbox !== "inbox") return;
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
        const ids = threadsToArchive.flatMap((thread) => thread.messageIds);
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
        if (!mailRowFocused || mailbox !== "inbox") return;
        // Toggle select-all of visible. Empty list = no-op.
        e.preventDefault();
        if (visibleThreads.length === 0) return;
        const allIds = visibleThreads.map((thread) => thread.threadId);
        const allCurrentlySelected =
          liveSelected.size === allIds.length &&
          allIds.every((id) => liveSelected.has(id));
        setSelected(allCurrentlySelected ? new Set() : new Set(allIds));
      } else if (e.key === "Escape") {
        if (liveSelected.size > 0 || mailRowFocused) {
          e.preventDefault();
          setSelected(new Set());
          setRowFocused(false);
        }
      } else if (e.key === "c" || e.key === "C") {
        if (!mailRowFocused) return;
        // Compose — Gmail convention.
        e.preventDefault();
        setActiveDraft(undefined);
        setComposeOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    visibleThreads,
    cursor,
    navigate,
    archiveOne,
    liveSelected,
    markThreadRead,
    mailbox,
    mailboxSearch,
    mailRowFocused,
  ]);

  useEffect(() => {
    if (mailRowFocused) {
      rowRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
    }
  }, [cursor, mailRowFocused]);

  const activeEmail = mailRowFocused
    ? visibleThreads[cursor]?.email
    : undefined;
  const focusedThread = mailRowFocused ? visibleThreads[cursor] : undefined;
  const mailboxLabel =
    MAILBOXES.find((candidate) => candidate.id === mailbox)?.label ?? "Mail";
  const detailPanelWidthClass = "w-[300px]";
  const unreadCount = useMemo(
    () =>
      mailbox === "inbox"
        ? visibleThreads.filter((thread) =>
            shouldShowUnreadIndicator(thread.email),
          ).length
        : 0,
    [mailbox, visibleThreads],
  );

  return (
    <div className="flex-1 flex h-full min-h-0 min-w-0">
      {!collapsed && (
        <aside
          data-woodshed-surface="mail-detail-list"
          className={`${detailPanelWidthClass} shrink-0 bg-list flex flex-col border-r border-border`}
        >
          {activeEmail ? (
            <EmailDetailPane email={activeEmail} people={people} />
          ) : null}
        </aside>
      )}

      <div
        data-mail-index-focused={mailRowFocused ? "true" : "false"}
        className="flex-1 flex flex-col bg-content min-h-0 min-w-0"
      >
        {/* `min-h-0` on both the column and the ScrollArea is what makes the
            inbox scroll at all. A flex item defaults to `min-height: auto`,
            so without it the ScrollArea grows to the full height of the
            message list, the viewport never overflows, and the rows past the
            fold are simply clipped by the shell's `overflow-hidden`. */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-8 py-6">
            <nav
              aria-label="Mail folders"
              className="mb-5 flex items-center gap-1 border-b border-border"
            >
              {MAILBOXES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={mailbox === item.id ? "page" : undefined}
                  onClick={() => changeMailbox(item.id)}
                  className={`relative px-3 pb-2 text-[13px] transition-colors ${
                    mailbox === item.id
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                  {mailbox === item.id && (
                    <span className="absolute inset-x-2 -bottom-px h-px bg-foreground" />
                  )}
                </button>
              ))}
            </nav>
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-xl font-semibold flex items-baseline gap-2">
                {mailboxLabel}
                {unreadCount > 0 && (
                  <span className="text-muted-foreground text-base font-normal">
                    {unreadCount}
                  </span>
                )}
                {mailbox === "inbox" && liveSelected.size > 0 && (
                  <span className="text-violet-500 text-[12px] font-normal">
                    {liveSelected.size} selected
                    <span className="text-muted-foreground/70 ml-1.5">
                      · e to archive · esc to clear
                    </span>
                  </span>
                )}
              </h1>
              <div className="flex items-center gap-2 text-muted-foreground">
                {mailbox === "inbox" && inboxes.length > 1 && (
                  <InboxFilter
                    inboxes={inboxes}
                    value={filterInbox}
                    onChange={setFilterInbox}
                  />
                )}
                {mailbox === "inbox" && (
                  <SyncRefreshButton
                    inboxId={
                      filterInbox === ALL_INBOXES ? undefined : filterInbox
                    }
                  />
                )}
                {mailbox === "inbox" && focusedThread && (
                  <SnoozeButton compact messageIds={focusedThread.messageIds} />
                )}
                <button
                  type="button"
                  aria-label="Compose"
                  title="Compose (c)"
                  onClick={() => {
                    setActiveDraft(undefined);
                    setComposeOpen(true);
                  }}
                  className="p-1.5 rounded hover:bg-foreground/[0.06] hover:text-foreground transition-colors"
                >
                  <Pencil className="h-4 w-4" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label="Search"
                  aria-pressed={searchOpen}
                  onClick={() => {
                    if (searchOpen) setSearchQuery("");
                    setSearchOpen((current) => !current);
                  }}
                  className="p-1.5 rounded hover:bg-foreground/[0.06] hover:text-foreground transition-colors"
                >
                  <Search className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>
            </div>

            {searchOpen && (
              <div className="mb-4 flex h-9 items-center gap-2 rounded-md border border-border bg-foreground/[0.02] px-3 focus-within:ring-2 focus-within:ring-[var(--focus-ring)]">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  type="search"
                  aria-label="Search mail"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={`Search ${mailboxLabel.toLowerCase()}`}
                  className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setSearchQuery("")}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}

            {mailbox === "drafts" ? (
              drafts.length === 0 ? (
                <EmptyMailFolder
                  folder="drafts"
                  isLoading={draftsLoading}
                  searching={!!searchQuery.trim()}
                  hasInboxes={inboxes.length > 0}
                />
              ) : (
                <div className="space-y-px">
                  {drafts.map((draft) => (
                    <DraftRow
                      key={draft.id}
                      draft={draft}
                      onClick={() => {
                        setActiveDraft(draft);
                        setComposeOpen(true);
                      }}
                    />
                  ))}
                </div>
              )
            ) : visibleThreads.length === 0 ? (
              <EmptyMailFolder
                folder={mailbox}
                isLoading={
                  isLoading || (mailbox === "inbox" && inboxesLoading)
                }
                searching={!!searchQuery.trim()}
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
                    mailbox={mailbox}
                    isCursor={mailRowFocused && idx === cursor}
                    isSelected={liveSelected.has(thread.threadId)}
                    onClick={() => {
                      setCursor(idx);
                      setRowFocused(true);
                      if (mailbox === "inbox") markThreadRead(thread);
                    }}
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
                    {isFetchingNextPage
                      ? "Loading older mail…"
                      : "Load older mail"}
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
          draft={activeDraft}
          onClose={() => {
            setComposeOpen(false);
            setActiveDraft(undefined);
          }}
        />
      )}
    </div>
  );
}

interface EmailRowProps {
  email: EmailSummary;
  messageCount: number;
  people: PersonDto[];
  mailbox: Mailbox;
  isCursor: boolean;
  isSelected: boolean;
  onClick: () => void;
  ref?: React.Ref<HTMLAnchorElement>;
}

function EmailRow({
  email,
  messageCount,
  people,
  mailbox,
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
  const isUnread = shouldShowUnreadIndicator(email);
  const correspondent =
    mailbox === "sent" && email.to?.length
      ? email.to.join(", ")
      : senderName;
  return (
    <Link
      to="/mail/$id"
      params={{ id: email.id }}
      search={mailbox === "inbox" ? {} : { mailbox }}
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
      <div
        className={`w-[160px] shrink-0 truncate text-sm ${
          isUnread
            ? "font-semibold text-foreground"
            : "font-medium text-muted-foreground"
        }`}
      >
        {correspondent}
      </div>
      <div className="flex-1 min-w-0 flex items-baseline gap-2 overflow-hidden">
        <span
          className={`text-sm truncate shrink-0 max-w-[45%] ${
            isUnread
              ? "font-semibold text-foreground"
              : "font-medium text-muted-foreground"
          }`}
        >
          {email.subject}
        </span>
        {messageCount > 1 && (
          <span className="text-xs text-muted-foreground shrink-0">
            {messageCount}
          </span>
        )}
        <span
          className={`text-sm truncate ${
            isUnread ? "text-foreground/70" : "text-muted-foreground"
          }`}
        >
          {email.preview}
        </span>
      </div>
      <span
        className={`text-xs shrink-0 tabular-nums ${
          isUnread ? "text-foreground/70" : "text-muted-foreground"
        }`}
      >
        {formatRelativeDate(email.date)}
      </span>
    </Link>
  );
}

function DraftRow({
  draft,
  onClick,
}: {
  draft: DraftDto;
  onClick: () => void;
}) {
  const recipients = draft.to.length
    ? draft.to.join(", ")
    : "No recipients";
  const preview = draft.body.replace(/\s+/g, " ").trim();
  return (
    <button
      type="button"
      data-mail-draft-row
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-md px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.025]"
    >
      <div className="w-2 shrink-0" />
      <div className="w-[160px] shrink-0 truncate text-sm font-medium">
        {recipients}
      </div>
      <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span className="max-w-[45%] shrink-0 truncate text-sm font-medium">
          {draft.subject.trim() || "No subject"}
        </span>
        {preview && (
          <span className="truncate text-sm text-muted-foreground">
            {preview}
          </span>
        )}
      </div>
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
        {formatRelativeDate(draft.created)}
      </span>
    </button>
  );
}

interface MailThread {
  threadId: string;
  email: EmailSummary;
  messageIds: string[];
  unreadMessageIds: string[];
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
        unreadMessageIds: email.read ? [] : [email.id],
      });
      continue;
    }

    existing.messageIds.push(email.id);
    if (!email.read) existing.unreadMessageIds.push(email.id);
    const anyUnread =
      shouldShowUnreadIndicator(existing.email) ||
      shouldShowUnreadIndicator(email);
    if (
      new Date(email.date).getTime() > new Date(existing.email.date).getTime()
    ) {
      existing.email = anyUnread
        ? { ...email, read: false, viewed: false }
        : email;
    } else if (anyUnread && !shouldShowUnreadIndicator(existing.email)) {
      existing.email = { ...existing.email, read: false, viewed: false };
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
  // is). `min-h-0` for the same reason as the message list: without it the
  // pane grows to fit a long preview and `overflow-y-auto` never engages.
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
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
            {shouldShowUnreadIndicator(email) && (
              <span
                aria-label="Unread"
                title="Unread"
                className="ml-auto inline-block h-2 w-2 rounded-full bg-blue-500"
              />
            )}
          </div>
          <div className="text-sm font-medium leading-snug">
            {email.subject}
          </div>
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

function EmptyMailFolder({
  folder,
  isLoading,
  searching,
  hasInboxes,
}: {
  folder: Mailbox;
  isLoading: boolean;
  searching: boolean;
  hasInboxes: boolean;
}) {
  // Stay blank during initial load so the no-inboxes setup screen
  // doesn't flash for users who do have inboxes — the inboxes query
  // returns [] until it resolves.
  if (isLoading) return null;
  if (searching) {
    const label =
      MAILBOXES.find((candidate) => candidate.id === folder)?.label ?? "mail";
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-muted-foreground">
          No matching {label.toLowerCase()}.
        </p>
      </div>
    );
  }
  if (folder === "inbox" && !hasInboxes) {
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
          . Your account shows up here as soon as you paste your App Password.
        </p>
      </div>
    );
  }
  if (folder === "drafts") {
    return (
      <div className="space-y-2 py-12 text-center">
        <p className="text-sm text-muted-foreground">No saved drafts.</p>
        <p className="text-[13px] text-muted-foreground">
          Start a message and close it; Woodshed saves it here automatically.
        </p>
      </div>
    );
  }
  if (folder === "sent" || folder === "archive") {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-muted-foreground">
          {folder === "sent" ? "No sent mail yet." : "No archived mail."}
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
      : (message ?? "Refresh mail (all providers)");

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
