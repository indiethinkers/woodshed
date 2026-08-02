import { createFileRoute } from "@tanstack/react-router";
import { isMailbox, type Mailbox } from "@/lib/mail-lib/types";

// Eager metadata only — the email detail view loads from
// mail/$id.lazy.tsx on demand.
export const Route = createFileRoute("/mail/$id")({
  validateSearch: (search: Record<string, unknown>): { mailbox?: Mailbox } => ({
    mailbox: isMailbox(search.mailbox) ? search.mailbox : undefined,
  }),
});
