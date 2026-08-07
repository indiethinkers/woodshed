import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ChevronDown,
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
import { splitQuotedBody } from "@/lib/mail-lib/trim-quoted";
import { toastMutationError } from "@/lib/mutation-toast";
import { addressAvatar } from "@/lib/avatars";
import { isEditableElement } from "@/lib/dom/is-editable";
import { mailOpenAttachment } from "@/lib/mail-lib/mail";
import {
  shouldShowUnreadIndicator,
  type Attachment,
  type EmailSummary,
  type Mailbox,
} from "@/lib/mail-lib/types";
import { Avatar } from "@/components/shared/avatar";
import { BacklinksPanel } from "@/components/shared/backlinks-panel";
import { OutgoingLinksPanel } from "@/components/shared/outgoing-links-panel";
import {
  ComposeDialog,
  type ComposeMode,
} from "@/components/mail/compose-dialog";
import { HtmlBody } from "@/components/mail/html-body";
import { InlineReply } from "@/components/mail/inline-reply";
import { SnoozeButton } from "@/components/mail/snooze-button";
import { Markdown } from "@/components/shared/markdown";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

interface EmailDetailProps {
  email: EmailSummary;
  mailbox?: Mailbox;
  onBack?: () => void;
  onOpenEmail?: (id: string | null) => void;
}

/**
 * Thread view: stacks every locally-persisted message that shares
 * `email.threadId` chronologically (oldest first), each as its own card
 * (Superhuman-style) — every message expanded, each with a sender avatar,
 * recipient line, and hover-revealed reply actions. Quoted reply history
 * is collapsed behind a "Show trimmed content" toggle.
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
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
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

  // The connected accounts' addresses, used to render our own address as
  // "me" in participant and recipient lines.
  const ownEmails = useMemo(
    () => new Set(inboxes.map((i) => i.email.toLowerCase())),
    [inboxes],
  );

  // Full recipient list for the newest message (received summaries don't
  // persist to/cc) — feeds the header participant line. The latest
  // ThreadMessage reads the same query, so this shares its cache entry.
  const { data: latestFull } = useEmailFull(latest.id, latest.inbox, true);

  // Gmail-style participant line for the header: unique senders across the
  // thread plus the newest message's recipients, with our own addresses
  // read as "me". Order = first appearance.
  const participants = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const message of messages) {
      const isSent = message.labels.some((label) => label.toLowerCase() === "sent");
      const name = isSent
        ? "me"
        : (findPersonForMailSender(people, message)?.name ?? message.from);
      const key = name.trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        names.push(name);
      }
    }
    for (const address of [
      ...(latestFull?.to ?? []),
      ...(latestFull?.cc ?? []),
    ]) {
      const label = ownEmails.has(normalizeEmail(address))
        ? "me"
        : recipientLabel(address);
      const key = label.trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        names.push(label);
      }
    }
    return names;
  }, [messages, people, latestFull, ownEmails]);
  const snoozableMessageIds = useMemo(
    () =>
      mailbox === "inbox"
        ? messages
            .filter(
              (message) =>
                message.path.startsWith("inbox/") ||
                message.labels.some((label) =>
                  label.toLowerCase().includes("inbox"),
                ),
            )
            .map((message) => message.id)
        : [],
    [mailbox, messages],
  );

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

  // Whether the conversation is still "following" the newest message.
  // Auto-follow starts true and stays true while the newest message's
  // bottom sits at the viewport bottom (or the viewport is at the very
  // end of the thread). The scroll listener below flips it off the
  // moment the user scrolls away, so late-loading email bodies never
  // yank the view back down while they're reading an earlier part —
  // and scrolling back to the newest position re-engages it.
  const followLatestRef = useRef(true);

  // Live view into whether the user is still following the newest message —
  // feeds useAutoMarkRead so a message that syncs in while the user reads
  // earlier mail stays unread (only watched arrivals are marked).
  const isFollowingNewest = useCallback(() => followLatestRef.current, []);

  // Scroll the focused message into view as the cursor moves, or land
  // on the newest message when a thread opens. Two modes:
  //
  //  - Auto-follow (userCursor === null): multi-message threads open at
  //    the BOTTOM of the newest message. `block: "end"` pins the
  //    message's bottom edge to the viewport's bottom edge no matter how
  //    tall the message is — the previous `block: "nearest"` aligned the
  //    message TOP with the viewport bottom, so a newest message taller
  //    than the viewport hid its own newest content below the fold. The
  //    view keeps following while content loads asynchronously — email
  //    bodies are auto-height iframes that resize via postMessage, and
  //    images resolve late — via a ResizeObserver on the whole thread.
  //    A second rAF re-pin beats ContentPanel's one-shot restore rAF,
  //    which can otherwise yank the view back to the top a frame later.
  //  - Cursor mode (userCursor !== null): j/k navigation brings the
  //    focused message into view with a minimal scroll.
  //
  // Single-message emails skip auto-follow: they land at the top so the
  // page header (subject, from row, action buttons) stays visible.
  useEffect(() => {
    if (messages.length <= 1 && userCursor === null) return;
    // Release ContentPanel's late-load scroll guard before the
    // programmatic scroll: the guard only listens for real user input on
    // the parent window, so without this it snaps the scrollIntoView
    // back to the top during its settle window. A synthetic wheel is
    // invisible to every other listener — the guard is the only window
    // wheel handler.
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true }));

    if (userCursor !== null) {
      messageRefs.current[selectedIdx]?.scrollIntoView({ block: "nearest" });
      return;
    }

    // Auto-follow: only re-anchor now while the user is still riding
    // the newest message — they may have scrolled away while a reply
    // synced in. The listener and observer below attach regardless, so
    // a re-run while disengaged (e.g. a new message syncs) keeps the
    // machinery alive and scrolling back to the newest position
    // re-engages the follow.
    const latestEl = messageRefs.current[lastIdx];
    const viewport = rootRef.current?.closest(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!latestEl) return;

    const pinLatestToBottom = () => {
      // A newest message taller than the viewport must NOT pin its bottom
      // to the viewport bottom — that lands the reader at the message's
      // footer ("scrolled too far down the page"). Pin its top instead so
      // the newest message is read from its header; shorter messages pin
      // their bottom so the reply strip stays in view.
      const viewport = rootRef.current?.closest(
        '[data-slot="scroll-area-viewport"]',
      );
      const viewportHeight =
        viewport instanceof HTMLElement ? viewport.clientHeight : 0;
      const tallerThanViewport = latestEl.offsetHeight > viewportHeight;
      latestEl.scrollIntoView({
        block: tallerThanViewport ? "start" : "end",
      });
    };
    let raf = 0;
    if (followLatestRef.current) {
      pinLatestToBottom();
      // The guard's restore rAF (content-panel.tsx) fires a frame after
      // mount and scrolls back to the remembered top; this rAF is
      // registered later, so it runs after and wins the frame. It must
      // stay UNGUARDED by followLatestRef: the yank's scroll event
      // disengages the follow a frame earlier, and this pin's own scroll
      // event re-engages it via the position check below.
      raf = window.requestAnimationFrame(pinLatestToBottom);
    }

    // While following, re-pin whenever the thread grows — an email
    // body's iframe auto-sizes via postMessage and images resolve
    // late — so the newest content stays anchored at the bottom.
    const observer =
      typeof ResizeObserver !== "undefined" && rootRef.current
        ? new ResizeObserver(() => {
            if (followLatestRef.current) pinLatestToBottom();
          })
        : null;
    if (observer && rootRef.current) observer.observe(rootRef.current);

    // Track whether the user is still at the newest position. Any scroll
    // that isn't our own pin moves the newest message away from the
    // viewport bottom (or the viewport away from the thread's end),
    // which disengages the follow; scrolling back re-engages it.
    const onScroll = () => {
      const msgBottom = latestEl.getBoundingClientRect().bottom;
      const vpBottom = viewport?.getBoundingClientRect().bottom ?? msgBottom;
      const atThreadEnd =
        viewport instanceof HTMLElement &&
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1;
      followLatestRef.current =
        Math.abs(msgBottom - vpBottom) <= 1 || atThreadEnd;
    };
    viewport?.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
      viewport?.removeEventListener("scroll", onScroll);
    };
  }, [selectedIdx, messages.length, userCursor, lastIdx]);

  // Any pointer interaction inside the conversation (clicking a collapsed
  // message to expand it, selecting a row, starting a reply) disengages the
  // auto-follow: the thread growing after that interaction must not yank
  // the view back down to the newest message.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const disengage = () => {
      followLatestRef.current = false;
    };
    root.addEventListener("pointerdown", disengage);
    return () => root.removeEventListener("pointerdown", disengage);
  }, []);

  const replyTarget = replyTargetId
    ? (messages.find((m) => m.id === replyTargetId) ?? null)
    : null;

  useAutoMarkRead(messages, isLoading, markRead, isFollowingNewest);

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
      archiveOne(m.id).catch((e) => toastMutationError("archive message", e));
    }
    openAfterAction(nextId);
  }, [mailbox, messages, archiveOne, nextEmailIdAfter, openAfterAction]);

  const handleDelete = useCallback(() => {
    const nextId = nextEmailIdAfter();
    for (const m of messages) {
      deleteOne(m.id).catch((e) => toastMutationError("remove message", e));
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
        if (compose) return;
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
    compose,
  ]);

  return (
    <div ref={rootRef}>
      {/* Header — driven by the latest message in the thread. */}
      {(() => {
        const inbox = inboxes.find((i) => i.inboxId === latest.inbox);
        const inboxLabel = inbox?.displayName || inbox?.email || latest.inbox;
        return (
          <div className="mb-5">
            {/* Superhuman-style reading header: the subject is the pane's
                title; the meta row below stays one quiet line. The message's
                own sender/time row lives inside the card, so the page header
                doesn't repeat a timestamp. */}
            <h1 className="text-2xl font-semibold tracking-tight leading-tight">
              {latest.subject}
            </h1>
            <div className="mt-1.5 flex items-baseline gap-2 text-sm text-muted-foreground">
              {shouldShowUnreadIndicator(latest) && (
                <span
                  aria-label="Unread"
                  title="Unread"
                  className="inline-block h-2 w-2 rounded-full bg-blue-500 shrink-0 self-center"
                />
              )}
              <span className="truncate font-medium text-foreground/80">
                {participants.join(", ")}
              </span>
              {messages.length > 1 && (
                <span className="shrink-0 text-xs">
                  {messages.length} messages
                </span>
              )}
              {latest.inbox && (
                <span
                  className="ml-auto flex items-center gap-1.5 text-xs shrink-0"
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
          <>
            <SnoozeButton
              messageIds={snoozableMessageIds}
              onSnoozed={() => openAfterAction(nextEmailIdAfter())}
            />
            <Button variant="outline" size="sm" onClick={handleArchive}>
              <Archive className="h-3.5 w-3.5 mr-1.5" />
              Archive
            </Button>
          </>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDeleteConfirmOpen(true)}
          className="text-muted-foreground hover:text-red-500"
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          Delete
        </Button>
      </div>

      {/* Reading stack (Superhuman-style): every message is its own card,
          raised off the panel canvas and separated by a small gap. The reply
          affordance is a card footer — on the targeted message while a reply
          is open, otherwise on the newest card. */}
      <div className="space-y-3">
        {messages.map((m, idx) => (
          <ThreadMessage
            key={m.id}
            message={m}
            isSelected={idx === selectedIdx}
            defaultCollapsed={messages.length > 3 && idx < messages.length - 1}
            ownEmails={ownEmails}
            onSelect={() => setUserCursor(idx)}
            onReply={() => setReplyTargetId(m.id)}
            onReplyAll={() => setCompose({ kind: "replyAll", source: m })}
            onForward={() => setCompose({ kind: "forward", source: m })}
            people={people}
            footer={
              replyTarget && replyTarget.id === m.id ? (
                <InlineReply
                  key={replyTarget.id}
                  message={replyTarget}
                  onClose={() => setReplyTargetId(null)}
                />
              ) : !replyTarget && idx === messages.length - 1 ? (
                <CollapsedReplyStrip
                  onReply={() =>
                    setReplyTargetId((messages[selectedIdx] ?? latest).id)
                  }
                  onForward={() => setCompose({ kind: "forward", source: latest })}
                />
              ) : undefined
            }
            ref={(el) => {
              messageRefs.current[idx] = el;
            }}
          />
        ))}
      </div>

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

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from Woodshed?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the message from your vault (recoverable in trash).
              Gmail is not updated — the message may still exist in your inbox
              online.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDeleteConfirmOpen(false);
                handleDelete();
              }}
            >
              Remove locally
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Detail-view fallback for messages opened from surfaces other than the inbox.
 * Each message is attempted once per mounted detail view. A remote failure is
 * reported without making an already-viewed message look unread again, and it
 * must not turn that render into an unbounded integration retry loop.
 *
 * Only the messages that were unread when the thread opened are marked read
 * unconditionally (that's the "opening" gesture). A message that arrives
 * LATER while the thread is open is marked read only while the user is still
 * following the newest message — i.e. actually watching it land — and stays
 * unread otherwise, so mail that syncs in while the user reads earlier
 * messages doesn't silently become "read before I opened it".
 *
 * `isFollowingNewest` should be memoized (stable identity): a new identity
 * per render re-runs the effect, which is harmless (attemptedIds dedupes)
 * but wasteful. The initial-unread set is captured on the first non-loading
 * render that has messages, so a thread that opens empty never misclassifies
 * its first arrivals as "later" arrivals.
 */
export function useAutoMarkRead(
  messages: EmailSummary[],
  isLoading: boolean,
  markRead: (id: string) => Promise<void>,
  isFollowingNewest: () => boolean = () => true,
) {
  const initialUnread = useRef<Set<string> | null>(null);
  const attemptedIds = useRef(new Set<string>());

  useEffect(() => {
    if (isLoading) return;
    if (initialUnread.current === null && messages.length > 0) {
      initialUnread.current = new Set(
        messages.filter((message) => !message.read).map((message) => message.id),
      );
    }
    const unreadIds = messages
      .filter((message) => {
        if (message.read || attemptedIds.current.has(message.id)) return false;
        if (initialUnread.current!.has(message.id)) return true;
        return isFollowingNewest();
      })
      .map((message) => message.id);
    if (unreadIds.length === 0) return;

    for (const id of unreadIds) {
      attemptedIds.current.add(id);
      void markRead(id).catch(() => {
        console.error("Automatic mark-read failed.");
      });
    }
  }, [isLoading, messages, markRead, isFollowingNewest]);
}

/**
 * Single message inside a Superhuman-style thread: every message is its
 * own rounded card raised off the canvas, separated from its siblings by
 * a small gap. In a long thread the earlier messages start collapsed to a
 * compact header row (Gmail collapses older responses so reading the
 * newest message doesn't mean scrolling a wall of quoted history) —
 * clicking a row or moving the j/k cursor onto it expands it. The header
 * carries the sender avatar, email, a clickable recipient line
 * ("to me, Meghan, Kelly"), the timestamp, and hover-revealed reply
 * actions. Quoted reply history collapses behind "Show trimmed content".
 * The reply affordance renders as the card's flush footer.
 *
 * `isSelected` drives the violet keyboard-cursor bar. `onSelect` lets
 * a click set the cursor without forcing the user to use j/k first.
 */
function ThreadMessage({
  message,
  isSelected,
  defaultCollapsed,
  ownEmails,
  onSelect,
  onReply,
  onReplyAll,
  onForward,
  people,
  footer,
  ref,
}: {
  message: EmailSummary;
  isSelected: boolean;
  /** Start collapsed (header row only) instead of showing the full body. */
  defaultCollapsed: boolean;
  /** Connected accounts' addresses, matched to render self as "me". */
  ownEmails: Set<string>;
  onSelect: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  people: PersonDto[];
  /** Rendered flush at the card's bottom edge (e.g. the reply strip on the
   *  newest message, or the inline composer under the message being replied
   *  to). Skipped while the row is collapsed. */
  footer?: React.ReactNode;
  ref?: React.Ref<HTMLDivElement>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [trimmedOpen, setTrimmedOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  // Gmail: focusing a collapsed message (j/k or click-select) reveals it.
  useEffect(() => {
    if (isSelected && collapsed) setCollapsed(false);
  }, [isSelected, collapsed]);

  const senderPerson = findPersonForMailSender(people, message);
  const senderName = senderPerson?.name ?? message.from;
  const senderEmail = senderPerson?.email ?? message.fromEmail;
  const isSent = message.labels.some((l) => l.toLowerCase() === "sent");
  const headerLabel = isSent ? "You" : senderName;
  const avatar = addressAvatar(senderName, senderEmail);

  // Recipient lists load lazily from disk. Sent records carry `to` on the
  // summary so their recipient line renders before the full read lands.
  const { data: full } = useEmailFull(message.id, message.inbox, true);
  const toList = full?.to ?? message.to ?? [];
  const ccList = full?.cc ?? [];
  const toSummary = recipientSummary(toList, ownEmails);
  const ccLabel =
    ccList.length > 0 ? `cc ${recipientSummary(ccList, ownEmails)}` : "";
  const mailedBy = mailedByDomain(message.fromEmail);
  const { body: visibleBody, quoted } = splitQuotedBody(message.body);

  return (
    <div
      ref={ref}
      data-mail-thread-message
      onClick={onSelect}
      className={cn(
        // Each message is its own card (Superhuman-style thread): rounded,
        // raised off the canvas, `overflow-hidden` keeps the flush footer
        // inside the rounded corners. The light-sheet vars make HTML bodies
        // render light in dark mode.
        "group relative overflow-hidden rounded-lg border border-border/90 bg-background shadow-sm wd-email-sheet",
      )}
    >
      {isSelected && (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[3px] rounded-r-sm bg-violet-500"
        />
      )}
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-label={`Expand message from ${headerLabel}`}
          title={message.subject}
          className="group flex w-full items-center gap-3 px-5 py-2.5 text-left"
        >
          <Avatar initials={avatar.initials} color={avatar.color} size="md" />
          <span className="min-w-0 flex-1">
            <span className="text-sm font-medium">{headerLabel}</span>
            <span className="ml-2 truncate text-xs text-muted-foreground">
              {message.preview || message.body || ""}
            </span>
          </span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {formatMessageDate(message.date)}
          </span>
          <ChevronDown className="h-3.5 w-3.5 -rotate-90 shrink-0 text-muted-foreground" />
        </button>
      ) : (
        <div className="px-5 py-5">
          {/* Message header: avatar, identity, recipient line, time, actions. */}
      <div className="flex items-start gap-3">
        <Avatar initials={avatar.initials} color={avatar.color} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{headerLabel}</span>
            <span className="font-mono text-xs text-muted-foreground truncate hidden sm:inline">
              {senderEmail}
            </span>
            <span className="ml-auto font-mono text-xs text-muted-foreground shrink-0">
              {new Date(message.date).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              })}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 flex-wrap">
            {toSummary && (
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
                <span>
                  to {toSummary}
                  {ccLabel && <span className="ml-1">· {ccLabel}</span>}
                </span>
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
                />
              </span>
            )}
            {/* Gmail reveals reply actions on hover. Keyboard focus reveals
                them too (focus-within), so tab users aren't left guessing. */}
            <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                onClick={onReply}
                className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors"
              >
                <Reply className="h-3 w-3" strokeWidth={1.75} />
                Reply
              </button>
              <button
                type="button"
                onClick={onReplyAll}
                className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors"
              >
                <ReplyAll className="h-3 w-3" strokeWidth={1.75} />
                Reply all
              </button>
              <button
                type="button"
                onClick={onForward}
                className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors"
              >
                <Forward className="h-3 w-3" strokeWidth={1.75} />
                Forward
              </button>
            </div>
          </div>
        </div>
      </div>
      {detailsOpen && (
        <div className="mt-2 rounded-md bg-muted/60 px-3 py-2 text-xs">
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
      <div className="pt-2">
        {message.attachments.length > 0 && (
          <AttachmentRow
            messageId={message.id}
            attachments={message.attachments}
          />
        )}
        {message.html ? (
          <HtmlBody messageId={message.id} />
        ) : (
          <>
            <Markdown text={visibleBody} className="text-base leading-7" />
            {quoted && !trimmedOpen && (
              <button
                type="button"
                onClick={() => setTrimmedOpen(true)}
                className="mt-3 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
              >
                <ChevronDown className="h-3 w-3" strokeWidth={1.75} />
                Show trimmed content
              </button>
            )}
            {quoted && trimmedOpen && (
              <div className="mt-3 border-t border-border/70 pt-3 opacity-70">
                <Markdown text={quoted} className="text-[13px] leading-6" />
              </div>
            )}
          </>
        )}
      </div>
        </div>
      )}
      {!collapsed && footer}
    </div>
  );
}

/**
 * Gmail's collapsed reply affordance: a one-line "Click here to Reply or
 * Forward" strip that is always present at the bottom of a conversation.
 * Clicking Reply expands the inline composer (targeting the focused
 * message); Forward opens the full composer. Replaced by the expanded
 * InlineReply while a reply is open.
 */
function CollapsedReplyStrip({
  onReply,
  onForward,
}: {
  onReply: () => void;
  onForward: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 border-t border-border/80 bg-background px-5 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-foreground/[0.02]">
      <Reply className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
      <span>Click here to</span>
      <button
        type="button"
        onClick={onReply}
        aria-label="Reply to this thread"
        className="font-medium text-foreground/80 hover:text-foreground hover:underline underline-offset-2 transition-colors"
      >
        Reply
      </button>
      <span>or</span>
      <button
        type="button"
        onClick={onForward}
        aria-label="Forward this thread"
        className="font-medium text-foreground/80 hover:text-foreground hover:underline underline-offset-2 transition-colors"
      >
        Forward
      </button>
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

// Gmail's "to me, Meghan, Kelly" line: up to three named recipients with
// our own address read as "me", then "and N more" for the rest. The same
// shape serves the cc suffix.
function recipientSummary(addrs: string[], ownEmails: Set<string>): string {
  if (addrs.length === 0) return "";
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const addr of addrs) {
    // Dedupe on the normalized address so two people sharing a first name
    // both appear; our own address collapses to "me".
    const normalized = normalizeEmail(addr);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const label = ownEmails.has(normalized) ? "me" : recipientLabel(addr);
    labels.push(label);
  }
  if (labels.length === 1) return labels[0];
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`;
}

function normalizeEmail(address: string): string {
  const angle = address.match(/<([^>]+)>/);
  return (angle?.[1] ?? address).trim().toLowerCase();
}

function formatMessageDate(date: string): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
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
