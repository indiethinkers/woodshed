import { createLazyFileRoute } from "@tanstack/react-router";
import { MailInbox } from "@/components/mail/mail-inbox";

export const Route = createLazyFileRoute("/mail/")({
  component: MailIndex,
});

export function MailIndex() {
  const { mailbox } = Route.useSearch();
  return <MailInbox mailbox={mailbox ?? "inbox"} />;
}
