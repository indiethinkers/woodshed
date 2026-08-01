import { createFileRoute } from "@tanstack/react-router";

// Eager metadata only — the MailInbox component (and its mail-lib +
// html-body sanitization deps) loads from mail/index.lazy.tsx.
export const Route = createFileRoute("/mail/")({});
