import { createFileRoute } from "@tanstack/react-router";

// Eager metadata only — the email detail view loads from
// mail/$id.lazy.tsx on demand.
export const Route = createFileRoute("/mail/$id")({});
