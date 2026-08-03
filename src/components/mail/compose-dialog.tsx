import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Maximize2,
  Minimize2,
  Paperclip,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  useDeleteDraft,
  useInboxes,
  useReplyMail,
  useSaveDraft,
  useSendMail,
} from "@/lib/hooks/use-mail";
import { inboxColor } from "@/lib/mail-lib/inbox-color";
import { replyRecipients } from "@/lib/mail-lib/reply-recipients";
import type {
  ComposeInput,
  DraftDto,
  DraftSaveInput,
  EmailSummary,
  Inbox,
  OutgoingAttachment,
  ReplyInput,
} from "@/lib/mail-lib/types";

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface SelectedAttachment extends OutgoingAttachment {
  size: number;
}

export type ComposeMode =
  | { kind: "new"; defaultFromInbox?: string }
  | { kind: "reply"; source: EmailSummary }
  | { kind: "replyAll"; source: EmailSummary }
  | { kind: "forward"; source: EmailSummary };

interface ComposeDialogProps {
  open: boolean;
  mode: ComposeMode;
  /** Existing draft to resume. When set, its body/subject/recipients seed the form. */
  draft?: DraftDto;
  onClose: () => void;
  /** Called after a successful send so the caller can navigate away if desired. */
  onSent?: () => void;
}

/**
 * Compose / reply / forward dialog. One component for all three modes:
 *   - new      → empty form, fromInbox defaults to first inbox the API key owns
 *   - reply    → pre-fills to/subject; body has the quoted source below
 *   - forward  → "Fwd: " subject, blank to, body has the quoted source
 *
 * Sends through `mail_send` (new + forward) or `mail_reply` (reply); both
 * persist a copy under `sent/` and invalidate the inbox + thread caches.
 *
 * Drafts: a debounced autosave writes to `drafts/<ulid>.md` after the user
 * types. Closing without sending leaves the draft in place; sending or the
 * explicit "Discard" button removes it.
 */
export function ComposeDialog({
  open,
  mode,
  draft,
  onClose,
  onSent,
}: ComposeDialogProps) {
  const { data: inboxes = [] } = useInboxes();
  const send = useSendMail();
  const reply = useReplyMail();
  const saveDraft = useSaveDraft();
  const deleteDraft = useDeleteDraft();

  const initial = useMemo(
    () => buildInitialState(mode, draft, inboxes),
    [mode, draft, inboxes],
  );

  const [fromInbox, setFromInbox] = useState<string>(initial.fromInbox);
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc);
  const [bcc, setBcc] = useState(initial.bcc);
  const [showCcBcc, setShowCcBcc] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [attachments, setAttachments] = useState<SelectedAttachment[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [draftId, setDraftId] = useState<string | undefined>(draft?.id);
  const [status, setStatus] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const draftKind =
    draft?.kind ??
    (mode.kind === "reply" || mode.kind === "replyAll" ? "reply" : "new");
  const draftSourceMessageId =
    draft?.sourceMessageId ?? ("source" in mode ? mode.source.id : undefined);
  const draftThreadId =
    draft?.threadId ??
    (mode.kind === "reply" || mode.kind === "replyAll"
      ? mode.source.threadId
      : undefined);
  const isReply =
    draftKind === "reply" && !!draftSourceMessageId && !!draftThreadId;

  // The parent drives "reset on a different message/mode" by changing the
  // `key` it passes to ComposeDialog — that remounts this component fresh,
  // so we don't need a setState-in-effect to mirror prop changes back into
  // local state.

  const subjectRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const draftIdRef = useRef<string | undefined>(draft?.id);
  const saveDraftRef = useRef(saveDraft);
  const autosaveChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    draftIdRef.current = draftId;
  }, [draftId]);

  useEffect(() => {
    saveDraftRef.current = saveDraft;
  });

  const queueDraftAutosave = useCallback((input: Omit<DraftSaveInput, "id">) => {
    const run = autosaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = await saveDraftRef.current({
          ...input,
          id: draftIdRef.current,
        });
        draftIdRef.current = saved.id;
        setDraftId(saved.id);
        setDraftSavedAt(Date.now());
      });
    // Keep later autosaves moving after a provider/filesystem failure, while
    // returning the unswallowed promise so an explicit close can stay open and
    // show a recoverable error instead of losing the user's latest edit.
    autosaveChainRef.current = run.catch((e) => {
      console.error("draft autosave failed", e);
    });
    return run;
  }, []);

  const currentDraftInput = useMemo<Omit<DraftSaveInput, "id">>(
    () => ({
      kind: draftKind,
      fromInbox: fromInbox || undefined,
      to: parseRecipients(to),
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
      subject,
      body,
      sourceMessageId: draftSourceMessageId,
      threadId: draftThreadId,
    }),
    [
      draftKind,
      fromInbox,
      to,
      cc,
      bcc,
      subject,
      body,
      draftSourceMessageId,
      draftThreadId,
    ],
  );

  // Focus the most useful field on open: To when empty, Body otherwise.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      if (!initial.to.length) toRef.current?.focus();
      else bodyRef.current?.focus();
    });
  }, [open, initial.to.length]);

  // Debounced draft autosave. Held back until the user has typed something
  // meaningful so we don't write empty files when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const hasContent =
      to.trim().length > 0 ||
      subject.trim().length > 0 ||
      body.trim().length > 0;
    if (!hasContent) return;
    const handle = window.setTimeout(() => {
      void queueDraftAutosave(currentDraftInput);
    }, 1200);
    return () => window.clearTimeout(handle);
  }, [
    open,
    to,
    subject,
    body,
    currentDraftInput,
    queueDraftAutosave,
  ]);

  const handleClose = useCallback(async () => {
    if (status === "sending") return;
    const hasContent =
      to.trim().length > 0 ||
      subject.trim().length > 0 ||
      body.trim().length > 0;
    try {
      if (hasContent) {
        await queueDraftAutosave(currentDraftInput);
      }
      onClose();
    } catch {
      setStatus("error");
      setError("Draft could not be saved. Keep this window open and try again.");
    }
  }, [status, to, subject, body, queueDraftAutosave, currentDraftInput, onClose]);

  // Esc closes the dialog. Cmd/Ctrl-Enter sends.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        void handleClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void handleSend();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    handleClose,
    fromInbox,
    to,
    cc,
    bcc,
    subject,
    body,
    attachments,
    status,
  ]);

  async function handleSend() {
    if (status === "sending") return;
    const recipients = parseRecipients(to);
    if (recipients.length === 0) {
      setStatus("error");
      setError("At least one recipient is required.");
      return;
    }
    if (!subject.trim() && !isReply) {
      setStatus("error");
      setError("Subject is required.");
      return;
    }

    setStatus("sending");
    setError(null);
    try {
      if (isReply && draftSourceMessageId && draftThreadId) {
        const input: ReplyInput = {
          inReplyToMessageId: draftSourceMessageId,
          threadId: draftThreadId,
          fromInbox: fromInbox || undefined,
          to: recipients,
          cc: parseRecipients(cc),
          body,
          attachments: attachments.map(toOutgoingAttachment),
        };
        await reply(input);
      } else {
        const input: ComposeInput = {
          fromInbox: fromInbox || undefined,
          to: recipients,
          cc: parseRecipients(cc),
          bcc: parseRecipients(bcc),
          subject,
          body,
          attachments: attachments.map(toOutgoingAttachment),
        };
        await send(input);
      }
      await autosaveChainRef.current.catch((e) =>
        console.error("draft autosave failed before cleanup", e),
      );
      const currentDraftId = draftIdRef.current;
      if (currentDraftId) {
        await deleteDraft(currentDraftId).catch((e) =>
          console.error("draft cleanup failed", e),
        );
      }
      setStatus("idle");
      toast.success(toastMessage(mode, isReply), {
        description: recipients.join(", "),
      });
      onSent?.();
      onClose();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDiscard() {
    await autosaveChainRef.current.catch((e) =>
      console.error("draft autosave failed before discard", e),
    );
    const currentDraftId = draftIdRef.current;
    if (currentDraftId) {
      await deleteDraft(currentDraftId).catch((e) =>
        console.error("draft delete failed", e),
      );
    }
    onClose();
  }

  async function handleAttachmentSelection(files: FileList | null) {
    if (!files?.length) return;
    const nextFiles = Array.from(files);
    if (attachments.length + nextFiles.length > MAX_ATTACHMENT_COUNT) {
      setError(`You can attach up to ${MAX_ATTACHMENT_COUNT} files.`);
      return;
    }
    if (nextFiles.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      setError("Each attachment must be 10 MB or smaller.");
      return;
    }
    const nextTotal =
      attachments.reduce((sum, attachment) => sum + attachment.size, 0) +
      nextFiles.reduce((sum, file) => sum + file.size, 0);
    if (nextTotal > MAX_TOTAL_ATTACHMENT_BYTES) {
      setError("Attachments must total 20 MB or less.");
      return;
    }

    try {
      const encoded = await Promise.all(
        nextFiles.map(async (file) => ({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          dataBase64: await readFileAsBase64(file),
          size: file.size,
        })),
      );
      setAttachments((current) => [...current, ...encoded]);
      setError(null);
    } catch {
      setError("Woodshed could not read that attachment.");
    }
  }

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const fromInboxObj = inboxes.find((i) => i.inboxId === fromInbox);

  const titleLabel =
    isReply
      ? "Reply"
      : mode.kind === "forward"
        ? "Forward"
        : "New message";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close compose"
        onClick={handleClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titleLabel}
        data-expanded={expanded ? "true" : "false"}
        className={`relative flex w-full flex-col overflow-hidden border border-border bg-popover text-popover-foreground shadow-2xl transition-[width,height,max-width] ${
          expanded
            ? "h-[calc(100vh-2rem)] max-w-[1100px] rounded-xl"
            : "max-h-[85vh] max-w-[640px] rounded-xl"
        }`}
      >
        <div className="flex items-center justify-between px-5 h-11">
          <h2 className="text-[13px] font-medium">{titleLabel}</h2>
          <div className="flex items-center gap-3">
            <span
              className={`text-[11px] text-muted-foreground transition-opacity duration-200 ${
                draftSavedAt ? "opacity-100" : "opacity-0"
              }`}
            >
              Draft saved
            </span>
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              aria-label={expanded ? "Restore compose" : "Expand compose"}
              title={expanded ? "Restore compose" : "Expand compose"}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              {expanded ? (
                <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
            </button>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close"
              className="-mr-1 p-1 rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        <div className="px-5 border-t border-border">
          {inboxes.length > 1 && (
            <FromRow
              inboxes={inboxes}
              value={fromInbox}
              onChange={setFromInbox}
            />
          )}
          {inboxes.length === 1 && fromInboxObj && (
            <FieldRow label="From">
              <span className="inline-flex items-center gap-1.5 text-[13px]">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: inboxColor(fromInboxObj.inboxId) }}
                  aria-hidden
                />
                <span>{fromInboxObj.email}</span>
              </span>
            </FieldRow>
          )}
          <FieldRow label="To">
            <input
              ref={toRef}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="someone@example.com"
              className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-muted-foreground/60"
              autoComplete="off"
              spellCheck={false}
            />
            {!showCcBcc && (
              <button
                type="button"
                onClick={() => setShowCcBcc(true)}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Cc / Bcc
              </button>
            )}
          </FieldRow>
          {showCcBcc && (
            <>
              <FieldRow label="Cc">
                <input
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  className="flex-1 bg-transparent outline-none text-[13px]"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FieldRow>
              <FieldRow label="Bcc">
                <input
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  className="flex-1 bg-transparent outline-none text-[13px]"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FieldRow>
            </>
          )}
          <FieldRow label="Subject" last>
            <input
              ref={subjectRef}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="flex-1 bg-transparent outline-none text-[13px] font-medium placeholder:font-normal placeholder:text-muted-foreground/60"
              autoComplete="off"
              spellCheck={false}
            />
          </FieldRow>
        </div>

        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2 border-t border-border px-5 py-2.5">
            {attachments.map((attachment, index) => (
              <li
                key={`${attachment.filename}-${index}`}
                className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-md border border-border bg-foreground/[0.025] px-2.5 py-1.5 text-[12px]"
              >
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{attachment.filename}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {formatBytes(attachment.size)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.filename}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((_, currentIndex) => currentIndex !== index),
                    )
                  }
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your message…"
          className={`flex-1 min-h-[260px] w-full resize-none border-t border-border bg-transparent px-5 py-4 text-[14px] leading-[22px] outline-none placeholder:text-muted-foreground/60 ${
            expanded ? "max-h-none" : "max-h-[50vh]"
          }`}
          spellCheck
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />

        {error && (
          <div className="px-5 py-2 border-t border-border bg-destructive/5 text-[12px] text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-5 h-12 border-t border-border">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleDiscard}
              disabled={status === "sending"}
              className="text-[12px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              Discard
            </button>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground">
              <Paperclip className="h-3.5 w-3.5" strokeWidth={1.75} />
              Attach
              <input
                type="file"
                multiple
                aria-label="Add attachments"
                className="sr-only"
                onChange={(event) => {
                  const files = event.currentTarget.files;
                  void handleAttachmentSelection(files);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={status === "sending" || to.trim().length === 0}
            title="Send (⌘↵)"
            className="inline-flex items-center gap-2 h-7 pl-3 pr-2.5 rounded-md bg-primary text-primary-foreground text-[12px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Send className="h-3 w-3" strokeWidth={2} />
            {status === "sending" ? "Sending…" : "Send"}
            <span className="ml-1 inline-flex items-center gap-px text-[10px] text-primary-foreground/70">
              <kbd className="font-mono">⌘</kbd>
              <kbd className="font-mono">↵</kbd>
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function toOutgoingAttachment({
  filename,
  contentType,
  dataBase64,
}: SelectedAttachment): OutgoingAttachment {
  return { filename, contentType, dataBase64 };
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file read failed"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const separator = value.indexOf(",");
      if (separator < 0) {
        reject(new Error("file encoding failed"));
        return;
      }
      resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FieldRow({
  label,
  children,
  last,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 h-9 ${
        last ? "" : "border-b border-border/50"
      }`}
    >
      <span className="w-14 shrink-0 text-[12px] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function FromRow({
  inboxes,
  value,
  onChange,
}: {
  inboxes: Inbox[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <FieldRow label="From">
      <div className="relative flex-1">
        {/* appearance-none + pl-0 strips the native select padding so the
            value text starts at the same x as the To/Subject inputs. */}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Send from"
          className="w-full appearance-none bg-transparent outline-none text-[13px] pl-0 pr-5 rounded"
        >
          {inboxes.map((i) => (
            <option key={i.inboxId} value={i.inboxId}>
              {i.displayName ? `${i.displayName} <${i.email}>` : i.email}
            </option>
          ))}
        </select>
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          <ChevronDown className="h-3 w-3" strokeWidth={1.75} />
        </span>
      </div>
    </FieldRow>
  );
}

function toastMessage(mode: ComposeMode, isReply: boolean): string {
  if (isReply) return "Reply sent";
  if (mode.kind === "forward") return "Forwarded";
  return "Email sent";
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildInitialState(
  mode: ComposeMode,
  draft: DraftDto | undefined,
  inboxes: Inbox[],
): {
  fromInbox: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
} {
  if (draft) {
    return {
      fromInbox: draft.fromInbox ?? inboxes[0]?.inboxId ?? "",
      to: draft.to.join(", "),
      cc: draft.cc.join(", "),
      bcc: draft.bcc.join(", "),
      subject: draft.subject,
      body: draft.body,
    };
  }
  if (mode.kind === "reply" || mode.kind === "replyAll") {
    const quoted = quote(mode.source);
    const subj = mode.source.subject.startsWith("Re:")
      ? mode.source.subject
      : `Re: ${mode.source.subject}`;
    const recipients =
      mode.kind === "replyAll"
        ? replyRecipients(mode.source, true)
        : replyRecipients(mode.source, false);
    return {
      fromInbox: mode.source.inbox || inboxes[0]?.inboxId || "",
      to: recipients.to.join(", "),
      cc: recipients.cc.join(", "),
      bcc: "",
      subject: subj,
      body: `\n\n${quoted}`,
    };
  }
  if (mode.kind === "forward") {
    const quoted = quote(mode.source);
    const subj = mode.source.subject.startsWith("Fwd:")
      ? mode.source.subject
      : `Fwd: ${mode.source.subject}`;
    return {
      fromInbox: mode.source.inbox || inboxes[0]?.inboxId || "",
      to: "",
      cc: "",
      bcc: "",
      subject: subj,
      body: `\n\n${quoted}`,
    };
  }
  return {
    fromInbox: mode.defaultFromInbox || inboxes[0]?.inboxId || "",
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
  };
}

/**
 * Plaintext "On {date}, {sender} wrote:" block with the source body
 * prefixed by "> ". The send path takes plaintext bodies, so a
 * Markdown-style quote is the closest approximation to a real
 * forwarded/replied-to message.
 */
function quote(source: EmailSummary): string {
  const date = new Date(source.date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const header = `On ${date}, ${source.from} <${source.fromEmail}> wrote:`;
  const quoted = (source.body || source.preview || "")
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
  return `${header}\n${quoted}`;
}
