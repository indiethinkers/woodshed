import { createFileRoute } from "@tanstack/react-router";
import { isMailbox, type Mailbox } from "@/lib/mail-lib/types";

// Eager metadata only — the MailInbox component (and its mail-lib +
// html-body sanitization deps) loads from mail/index.lazy.tsx.
export const Route = createFileRoute("/mail/")({
  validateSearch: (search: Record<string, unknown>): { mailbox?: Mailbox } => ({
    mailbox: isMailbox(search.mailbox) ? search.mailbox : undefined,
  }),
});
