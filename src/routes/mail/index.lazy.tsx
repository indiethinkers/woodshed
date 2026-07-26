import { lazy, Suspense } from "react";
import { createLazyFileRoute } from "@tanstack/react-router";
import { MailInbox } from "@/components/mail/mail-inbox";

const MailSweep = lazy(() =>
  import("@/components/mail/mail-surface").then((module) => ({
    default: module.MailSurface,
  })),
);

export const Route = createLazyFileRoute("/mail/")({
  component: MailIndex,
});

export function MailIndex() {
  const { mode } = Route.useSearch();

  if (mode !== "sweep") return <MailInbox />;

  return (
    <Suspense
      fallback={
        <div
          aria-label="Loading AI Sweep"
          className="min-h-0 flex-1 bg-content"
        />
      }
    >
      <MailSweep />
    </Suspense>
  );
}
