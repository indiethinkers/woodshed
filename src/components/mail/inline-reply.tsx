import { useEffect, useRef, useState } from "react";
import { Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useReplyMail } from "@/lib/hooks/use-mail";
import { replyRecipients } from "@/lib/mail-lib/reply-recipients";
import type { EmailSummary, ReplyInput } from "@/lib/mail-lib/types";

interface InlineReplyProps {
  /** The message being replied to. Drives To/threadId/inbox. */
  message: EmailSummary;
  /** Called whether the reply was sent or discarded — closes the inline composer. */
  onClose: () => void;
}

/**
 * Superhuman-style inline reply card. Lives at the bottom of the thread
 * view, replies to a specific message in the thread (not always the
 * latest — driven by the user's cursor position).
 *
 * Esc cancels (with confirm if there's content); ⌘↵ sends. Body autofocuses
 * on mount so typing is immediate.
 *
 * For multi-recipient and full edit ergonomics (cc, subject changes), the
 * modal ComposeDialog is still the right surface — this is just the fast
 * path for "type a quick reply and send."
 */
export function InlineReply({ message, onClose }: InlineReplyProps) {
  const reply = useReplyMail();
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const recipients = replyRecipients(message, false).to;
  const recipientLabel = recipients[0] ?? message.fromEmail;

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  async function handleSend() {
    if (status === "sending") return;
    if (!body.trim()) {
      setStatus("error");
      setError("Reply body is empty.");
      return;
    }
    setStatus("sending");
    setError(null);
    try {
      const input: ReplyInput = {
        inReplyToMessageId: message.id,
        threadId: message.threadId,
        fromInbox: message.inbox,
        to: recipients.length > 0 ? recipients : undefined,
        body,
      };
      await reply(input);
      toast.success("Reply sent", { description: recipientLabel });
      onClose();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!body.trim() || window.confirm("Discard this reply?")) {
        onClose();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void handleSend();
    }
  }

  return (
    <div className="border border-border rounded-md bg-background overflow-hidden mt-3">
      <div className="px-4 py-2 border-b border-border flex items-baseline gap-2 text-[12px]">
        <span className="text-emerald-600 font-semibold">Draft</span>
        <span className="text-muted-foreground">to</span>
        <span className="font-mono text-[11px] font-medium">
          {recipientLabel}
        </span>
      </div>

      <textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type your reply…"
        className="w-full min-h-[120px] max-h-[40vh] resize-none px-4 py-3 bg-transparent outline-none text-[13.5px] leading-5 placeholder:text-muted-foreground"
        spellCheck
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />

      {error && (
        <div className="px-4 py-2 border-t border-border bg-destructive/5 text-[12px] text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 px-4 h-11 border-t border-border bg-foreground/[0.02]">
        <button
          type="button"
          onClick={onClose}
          disabled={status === "sending"}
          className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" strokeWidth={1.75} />
          Discard
        </button>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <kbd className="inline-flex items-center px-1.5 h-5 rounded font-medium bg-foreground/[0.06] border border-border">
            ⌘
          </kbd>
          <kbd className="inline-flex items-center px-1.5 h-5 rounded font-medium bg-foreground/[0.06] border border-border">
            ↵
          </kbd>
          <span>to send</span>
          <button
            type="button"
            onClick={handleSend}
            disabled={status === "sending" || body.trim().length === 0}
            className="ml-2 inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-primary text-primary-foreground text-[12px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Send className="h-3 w-3" strokeWidth={2} />
            {status === "sending" ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
