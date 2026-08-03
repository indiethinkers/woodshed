import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FileImage,
  FileText,
  Forward,
  Loader2,
  Paperclip,
  Reply,
  ReplyAll,
  Trash2,
} from "lucide-react";
import {
  useArchiveOne,
  useDeleteOne,
  useEmailFull,
  useInboxes,
  useAllMail,
  useMarkRead,
  useThread,
} from "@/lib/hooks/use-mail";
import { useAllPeople, type PersonDto } from "@/lib/hooks/use-people";
import { inboxColor } from "@/lib/mail-lib/inbox-color";
import { findPersonForMailSender } from "@/lib/mail-lib/people";
import { isEditableElement } from "@/lib/dom/is-editable";
import { mailOpenAttachment } from "@/lib/mail-lib/mail";
import {
  shouldShowUnreadIndicator,
  type Attachment,
  type EmailSummary,
  type Mailbox,
} from "@/lib/mail-lib/types";
import { BacklinksPanel } from "@/components/shared/backlinks-panel";
import { OutgoingLinksPanel } from "@/components/shared/outgoing-links-panel";
import {
  ComposeDialog,
  type ComposeMode,
} from "@/components/mail/compose-dialog";
import { HtmlBody } from "@/components/mail/html-body";
import { InlineReply } from "@/components/mail/inline-reply";
import { Markdown } from "@/components/shared/markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EmailDetailProps {
  email: EmailSummary;
  mailbox?: Mailbox;
  onBack?: () => void;
  onOpenEmail?: (id: string | null) => void;
}

/**
 * Thread view: stacks every locally-persisted message that shares
 * `email.threadId` chronologically (oldest first). The latest message is
 * expanded by default; older messages collapse to a one-line summary.
 *
 * Side effects on mount:
 *   - escape returns to /mail (Superhuman behavior)
 *   - every unread message in the thread is marked read on Gmail and
 *     the local files are rewritten with the updated labels
 */
export function EmailDetail({
  email,
  mailbox = "inbox",
  onBack,
  onOpenEmail,
}: EmailDetailProps) {
  const navigate = useNavigate();
  const mailboxSearch = useMemo(
    () => (mailbox === "inbox" ? {} : { mailbox }),
    [mailbox],
  );
  const { data: thread = [], isLoading } = useThread(email.threadId);
  const { data: inboxes = [] } = useInboxes();
  const { data: inboxList = [] } = useAllMail();
  const { data: people = [] } = useAllPeople();
  const markRead = useMarkRead();
  const archiveOne = useArchiveOne();
  const deleteOne = useDeleteOne();
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);

  // Render the thread we have on disk; fall back to the single message
  // when nothing else has landed yet (which is the common case for a
  // freshly-synced inbox). Memoized so dependents (effects, prefetch,
  // archive/delete callbacks) don't fire on every render in the
  // thread-empty case where the ternary would otherwise mint a fresh
  // `[email]` array each render.
  const messages = useMemo(
    () => (thread.length > 0 ? thread : [email]),
    [thread, email],
  );
  const latest = messages[messages.length - 1];
  const [openMessageIds, setOpenMessageIds] = useState<Set<string>>(() =>
    isLoading ? new Set() : new Set([latest.id]),
  );
  const initializedOpenState = useRef(!isLoading);

  // The route-level message is only a temporary fallback while the complete
  // local thread loads. Initialize expansion from the complete result so that
  // fallback does not remain open next to the actual newest message.
  useEffect(() => {
    if (isLoading || initializedOpenState.current) return;
    initializedOpenState.current = true;
    setOpenMessageIds(new Set([latest.id]));
  }, [isLoading, latest.id]);

  // Cursor for keyboard navigation through the thread. Null = no manual
  // navigation yet, so the cursor tracks the newest message (which is
  // what the user lands on when opening a thread). Once they hit j/k or
  // click a row, we pin the cursor to that position. Clamped at render
  // time so a shrinking thread auto-corrects without setState-in-effect.
  const [userCursor, setUserCursor] = useState<number | null>(null);
  const lastIdx = Math.max(0, messages.length - 1);
  const selectedIdx =
    userCursor === null ? lastIdx : Math.min(Math.max(0, userCursor), lastIdx);
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Reset the surrounding ScrollArea to the top whenever a new email
  // mounts. Without this the viewport retains the previous email's
  // scroll position (the parent route uses `key={email.id}` so this
  // effect fires once per email).
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = rootRef.current?.closest(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport instanceof HTMLElement) {
      viewport.scrollTop = 0;
    }
  }, []);

  // Scroll the focused message into view as the cursor moves. Skip on
  // the initial render of a single-message email — when the message body
  // is taller than the viewport, `block: "nearest"` aligns the message
  // top with the viewport top, which hides the page header (subject,
  // from row, action buttons). The dedicated scroll-to-top effect above
  // already lands those emails at the top. Multi-message threads still
  // scroll to the latest message on mount.
  useEffect(() => {
    if (messages.length <= 1 && userCursor === null) return;
    messageRefs.current[selectedIdx]?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, messages.length, userCursor]);

  const replyTarget = replyTargetId
    ? (messages.find((m) => m.id === replyTargetId) ?? null)
    : null;

  useAutoMarkRead(messages, isLoading, markRead);

  // Find the row that follows this thread in the inbox list — used to
  // jump straight to the next email when archiving or deleting, so the
  // user can hit `e` repeatedly toward inbox zero without bouncing back
  // to the list each time. Computed at action time (not in render) so it
  // reflects the list state at the moment of the keystroke, before the
  // optimistic archive removes this row.
  const nextEmailIdAfter = useCallback((): string | null => {
    const threadIds = new Set(messages.map((m) => m.id));
    const currentIdx = inboxList.findIndex((row) => threadIds.has(row.id));
    if (currentIdx < 0) return null;
    for (let i = currentIdx + 1; i < inboxList.length; i++) {
      if (!threadIds.has(inboxList[i].id)) return inboxList[i].id;
    }
    return null;
  }, [messages, inboxList]);

  const openAfterAction = useCallback(
    (nextId: string | null) => {
      if (onOpenEmail) {
        onOpenEmail(nextId);
      } else if (nextId) {
        navigate({
          to: "/mail/$id",
          params: { id: nextId },
          search: mailboxSearch,
        });
      } else {
        navigate({ to: "/mail", search: mailboxSearch });
      }
    },
    [mailboxSearch, navigate, onOpenEmail],
  );

  const handleArchive = useCallback(() => {
    if (mailbox !== "inbox") return;
    const nextId = nextEmailIdAfter();
    // useArchiveOne updates the cache synchronously and runs the
    // network call in the background — don't await, so the next email
    // opens immediately.
    for (const m of messages) {
      archiveOne(m.id).catch((e) => console.error("archive failed", e));
    }
    openAfterAction(nextId);
  }, [mailbox, messages, archiveOne, nextEmailIdAfter, openAfterAction]);

  const handleDelete = useCallback(() => {
    const nextId = nextEmailIdAfter();
    for (const m of messages) {
      deleteOne(m.id).catch((e) => console.error("delete failed", e));
    }
    openAfterAction(nextId);
  }, [messages, deleteOne, nextEmailIdAfter, openAfterAction]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && isEditableElement(target)) return;

      if (e.key === "Escape") {
        e.preventDefault();
        if (onBack) {
          onBack();
        } else {
          navigate({ to: "/mail", search: mailboxSearch });
        }
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setUserCursor((c) =>
          Math.min(messages.length - 1, (c ?? selectedIdx) + 1),
        );
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setUserCursor((c) => Math.max(0, (c ?? selectedIdx) - 1));
      } else if (e.key === "Enter") {
        // Superhuman: Enter on a focused message starts a reply to it.
        e.preventDefault();
        const target = messages[selectedIdx] ?? latest;
        setReplyTargetId(target.id);
      } else if (
        mailbox === "inbox" &&
        !e.shiftKey &&
        (e.key === "e" || e.key === "E")
      ) {
        // Superhuman / Gmail convention: E archives the open thread.
        e.preventDefault();
        handleArchive();
      } else if (!e.shiftKey && (e.key === "r" || e.key === "R")) {
        // R opens an inline reply to the focused message.
        e.preventDefault();
        const target = messages[selectedIdx] ?? latest;
        setReplyTargetId(target.id);
      } else if (e.shiftKey && e.key === "R") {
        // Shift-R opens Reply All in the full composer with editable recipients.
        e.preventDefault();
        setCompose({ kind: "replyAll", source: latest });
      } else if (!e.shiftKey && (e.key === "f" || e.key === "F")) {
        // F forwards the latest message.
        e.preventDefault();
        setCompose({ kind: "forward", source: latest });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    navigate,
    mailbox,
    mailboxSearch,
    onBack,
    handleArchive,
    latest,
    messages,
    selectedIdx,
  ]);

  return (
    <div ref={rootRef}>
      {/* Header — driven by the latest message in the thread. */}
      {(() => {
        const inbox = inboxes.find((i) => i.inboxId === latest.inbox);
        const inboxLabel = inbox?.displayName || inbox?.email || latest.inbox;
        return (
          <div className="mb-4">
            <h1 className="text-lg font-semibold">{latest.subject}</h1>
            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
              {shouldShowUnreadIndicator(latest) && (
                <span
                  aria-label="Unread"
                  title="Unread"
                  className="inline-block h-2 w-2 rounded-full bg-blue-500 shrink-0"
                />
              )}
              <span>
                {messages.length > 1
                  ? `${messages.length} messages`
                  : latest.from}
              </span>
              <span className="font-mono text-xs">
                {new Date(latest.date).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                })}
              </span>
              {latest.inbox && (
                <span
                  className="ml-auto flex items-center gap-1.5 text-xs"
                  title={`Received at ${inboxLabel}`}
                >
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: inboxColor(latest.inbox) }}
                  />
                  <span className="font-mono">{inboxLabel}</span>
                </span>
              )}
            </div>
          </div>
        );
      })()}

      {/* Action buttons. Reply targets whichever message the j/k cursor
          (or click) most recently focused — defaults to the latest. */}
      <div className="mb-6 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setReplyTargetId((messages[selectedIdx] ?? latest).id)}
        >
          <Reply className="h-3.5 w-3.5 mr-1.5" />
          Reply
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setCompose({
              kind: "replyAll",
              source: messages[selectedIdx] ?? latest,
            })
          }
        >
          <ReplyAll className="h-3.5 w-3.5 mr-1.5" />
          Reply all
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setCompose({
              kind: "forward",
              source: messages[selectedIdx] ?? latest,
            })
          }
        >
          <Forward className="h-3.5 w-3.5 mr-1.5" />
          Forward
        </Button>
        {mailbox === "inbox" && (
          <Button variant="outline" size="sm" onClick={handleArchive}>
            <Archive className="h-3.5 w-3.5 mr-1.5" />
            Archive
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={handleDelete}
          className="text-muted-foreground hover:text-red-500"
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          Delete
        </Button>
      </div>

      <div className="space-y-4">
        {messages.map((m, idx) => (
          <ThreadMessage
            key={m.id}
            message={m}
            open={openMessageIds.has(m.id)}
            onToggle={() => {
              setOpenMessageIds((current) => {
                const next = new Set(current);
                if (next.has(m.id)) next.delete(m.id);
                else next.add(m.id);
                return next;
              });
            }}
            isSelected={idx === selectedIdx}
            onSelect={() => setUserCursor(idx)}
            onReply={() => setReplyTargetId(m.id)}
            onReplyAll={() => setCompose({ kind: "replyAll", source: m })}
            onForward={() => setCompose({ kind: "forward", source: m })}
            people={people}
            ref={(el) => {
              messageRefs.current[idx] = el;
            }}
          />
        ))}
      </div>

      {replyTarget && (
        <InlineReply
          key={replyTarget.id}
          message={replyTarget}
          onClose={() => setReplyTargetId(null)}
        />
      )}

      <OutgoingLinksPanel sourceId={latest.id} />
      <BacklinksPanel targetId={latest.id} />

      {compose && (
        <ComposeDialog
          key={composeKey(compose)}
          open
          mode={compose}
          onClose={() => setCompose(null)}
        />
      )}
    </div>
  );
}

/**
 * Detail-view fallback for messages opened from surfaces other than the inbox.
 * Each message is attempted once per mounted detail view. A remote failure is
 * reported without making an already-viewed message look unread again, and it
 * must not turn that render into an unbounded integration retry loop.
 */
export function useAutoMarkRead(
  messages: EmailSummary[],
  isLoading: boolean,
  markRead: (id: string) => Promise<void>,
) {
  const attemptedIds = useRef(new Set<string>());

  useEffect(() => {
    if (isLoading) return;
    const unreadIds = messages
      .filter(
        (message) => !message.read && !attemptedIds.current.has(message.id),
      )
      .map((message) => message.id);
    if (unreadIds.length === 0) return;

    for (const id of unreadIds) {
      attemptedIds.current.add(id);
      void markRead(id).catch(() => {
        console.error("Automatic mark-read failed.");
      });
    }
  }, [isLoading, messages, markRead]);
}

/**
 * Single message inside a thread. The newest message expands by default;
 * older ones collapse to a single-line preview the user can click open.
 *
 * `isSelected` drives the violet keyboard-cursor border. `onSelect` lets
 * a click set the cursor without forcing the user to use j/k first.
 */
function ThreadMessage({
  message,
  open,
  onToggle,
  isSelected,
  onSelect,
  onReply,
  onReplyAll,
  onForward,
  people,
  ref,
}: {
  message: EmailSummary;
  open: boolean;
  onToggle: () => void;
  isSelected: boolean;
  onSelect: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  people: PersonDto[];
  ref?: React.Ref<HTMLDivElement>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const senderPerson = findPersonForMailSender(people, message);
  const senderName = senderPerson?.name ?? message.from;
  const senderEmail = senderPerson?.email ?? message.fromEmail;
  const isSent = message.labels.some((l) => l.toLowerCase() === "sent");
  const headerLabel = isSent ? "You" : senderName;

  // Lazily load to/cc from disk only when the message is expanded — an
  // open thread can have many older messages and we don't want to read
  // every one for messages the user hasn't unfolded.
  const { data: full } = useEmailFull(message.id, message.inbox, open);
  const toList = full?.to ?? [];
  const ccList = full?.cc ?? [];
  const toSummary = recipientSummary(toList);
  const mailedBy = mailedByDomain(message.fromEmail);

  return (
    <div
      ref={ref}
      className={cn(
        "relative overflow-hidden border border-border rounded-md bg-background transition-shadow duration-200",
        // The light sheet applies only while the message is open. Sender HTML
        // forces a light canvas, so an open message is a document either way
        // and the whole card should agree with it. A collapsed row shows no
        // sender content at all, so it stays part of the app's themed chrome
        // rather than turning a thread into a stack of white bars.
        open && "wd-email-sheet",
        isSelected &&
          "shadow-[0_1px_3px_rgba(124,58,237,0.08),0_8px_24px_-12px_rgba(124,58,237,0.22)]",
      )}
    >
      <button
        type="button"
        onClick={() => {
          onSelect();
          onToggle();
        }}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-foreground/[0.02] transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium truncate">{headerLabel}</span>
            <span className="font-mono text-xs text-muted-foreground truncate">
              {senderEmail}
            </span>
          </div>
          {!open && (
            <div className="text-[13px] text-muted-foreground truncate mt-0.5">
              {message.preview}
            </div>
          )}
          {open && toSummary && (
            <div className="mt-0.5">
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  setDetailsOpen((d) => !d);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    setDetailsOpen((d) => !d);
                  }
                }}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground rounded-sm cursor-pointer"
                aria-expanded={detailsOpen}
                aria-label={
                  detailsOpen ? "Hide message details" : "Show message details"
                }
              >
                <span>to {toSummary}</span>
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
                />
              </span>
            </div>
          )}
        </div>
        <span className="font-mono text-xs text-muted-foreground shrink-0 mt-0.5">
          {new Date(message.date).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })}
        </span>
      </button>
      {open && detailsOpen && (
        <div className="mx-4 mb-3 rounded-md bg-muted/60 px-3 py-2 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">from:</dt>
            <dd className="break-words">
              {senderName}{" "}
              <span className="text-muted-foreground">
                &lt;{senderEmail}&gt;
              </span>
            </dd>
            <dt className="text-muted-foreground">to:</dt>
            <dd className="break-words">
              {toList.length > 0 ? toList.join(", ") : "—"}
            </dd>
            {ccList.length > 0 && (
              <>
                <dt className="text-muted-foreground">cc:</dt>
                <dd className="break-words">{ccList.join(", ")}</dd>
              </>
            )}
            <dt className="text-muted-foreground">date:</dt>
            <dd>
              {new Date(message.date).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              })}
            </dd>
            <dt className="text-muted-foreground">subject:</dt>
            <dd className="break-words">{message.subject}</dd>
            {mailedBy && (
              <>
                <dt className="text-muted-foreground">mailed-by:</dt>
                <dd>{mailedBy}</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-border">
          {message.attachments.length > 0 && (
            <AttachmentRow
              messageId={message.id}
              attachments={message.attachments}
            />
          )}
          {message.html ? (
            <HtmlBody messageId={message.id} />
          ) : (
            <Markdown text={message.body} className="text-base leading-7" />
          )}
          <div className="mt-5 flex flex-wrap gap-2 border-t border-border/70 pt-3">
            <Button type="button" variant="ghost" size="sm" onClick={onReply}>
              <Reply className="h-3.5 w-3.5 mr-1.5" />
              Reply
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onReplyAll}
            >
              <ReplyAll className="h-3.5 w-3.5 mr-1.5" />
              Reply all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onForward}
            >
              <Forward className="h-3.5 w-3.5 mr-1.5" />
              Forward
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AttachmentRow({
  messageId,
  attachments,
}: {
  messageId: string;
  attachments: Attachment[];
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  async function onOpen(id: string) {
    setErrorId(null);
    setBusyId(id);
    try {
      await mailOpenAttachment(messageId, id);
    } catch {
      setErrorId(id);
    } finally {
      setBusyId(null);
    }
  }
  return (
    <div className="flex flex-wrap gap-2 pt-3 pb-4">
      {attachments.map((a) => {
        const Icon = pickAttachmentIcon(a.contentType);
        const busy = busyId === a.id;
        const failed = errorId === a.id;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onOpen(a.id)}
            disabled={busy}
            className={`inline-flex items-center gap-2 px-3 h-8 rounded-sm border text-[13px] transition-colors ${
              failed
                ? "border-destructive/40 text-destructive"
                : "border-border text-foreground hover:bg-muted"
            } disabled:opacity-60`}
            title={failed ? "Failed to open — try again" : a.filename}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="max-w-[24ch] truncate">{a.filename}</span>
            <span className="text-muted-foreground">{formatBytes(a.size)}</span>
          </button>
        );
      })}
    </div>
  );
}

function pickAttachmentIcon(contentType: string) {
  if (contentType.startsWith("image/")) return FileImage;
  if (
    contentType.startsWith("application/pdf") ||
    contentType.startsWith("text/")
  ) {
    return FileText;
  }
  return Paperclip;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Address strings arrive as either bare emails (`name@host`) or RFC 5322
// form (`Display Name <name@host>`). Pull the display name when present,
// otherwise the local-part of the email — that
// matches Gmail's "to jordan" inline label.
function recipientLabel(addr: string): string {
  const angle = addr.match(/^\s*([^<]+?)\s*<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1].replace(/^"|"$/g, "").trim();
    if (name) return name.split(/\s+/)[0];
    return localPart(angle[2]);
  }
  return localPart(addr);
}

function recipientSummary(addrs: string[]): string {
  if (addrs.length === 0) return "";
  const first = recipientLabel(addrs[0]);
  if (addrs.length === 1) return first;
  return `${first} and ${addrs.length - 1} other${addrs.length - 1 === 1 ? "" : "s"}`;
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

function mailedByDomain(email: string | undefined | null): string {
  if (!email) return "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(at + 1) : "";
}

function composeKey(mode: ComposeMode): string {
  if (mode.kind === "new") return "new";
  return `${mode.kind}:${mode.source.id}`;
}
