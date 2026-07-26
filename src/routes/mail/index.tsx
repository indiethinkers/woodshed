import { createFileRoute } from "@tanstack/react-router";

export type MailSearch = { mode?: "sweep" };

export function validateMailSearch(
  search: Record<string, unknown>,
): MailSearch {
  return search.mode === "sweep" ? { mode: "sweep" } : {};
}

// Eager metadata only — the MailInbox component (and its mail-lib +
// html-body sanitization deps) loads from mail/index.lazy.tsx.
export const Route = createFileRoute("/mail/")({
  validateSearch: validateMailSearch,
});
