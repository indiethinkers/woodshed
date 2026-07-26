import { createFileRoute } from "@tanstack/react-router";

// Eager metadata only — RowDetail (Tiptap + selectOptionColor +
// column-utils) loads from the .lazy sibling on first visit.
export const Route = createFileRoute("/databases/$id/$rowId")({});
