import { createLazyFileRoute, useParams } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { EmailDetail } from "@/components/mail/email-detail";
import { useEmail } from "@/lib/hooks/use-mail";

export const Route = createLazyFileRoute("/mail/$id")({
  component: EmailView,
});

function EmailView() {
  const { id } = useParams({ from: "/mail/$id" });
  const { mailbox } = Route.useSearch();
  const { data: email, isLoading } = useEmail(id);

  if (isLoading) {
    return (
      <ContentPanel showTopbar={false}>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </ContentPanel>
    );
  }

  if (!email) {
    return (
      <ContentPanel showTopbar={false}>
        <p className="text-sm text-muted-foreground">Email not found.</p>
      </ContentPanel>
    );
  }

  return (
    <ContentPanel showTopbar={false} comfortable>
      {/* key on the message id so EmailDetail remounts on route change —
          state (cursor, inline-reply target, expanded messages) resets
          without needing a setState-in-effect inside the component. */}
      <EmailDetail
        key={email.id}
        email={email}
        mailbox={mailbox ?? "inbox"}
      />
    </ContentPanel>
  );
}
