import { createFileRoute } from "@tanstack/react-router";

// Eager metadata only — CustomTableView loads from the .lazy sibling
// on first visit.
export const Route = createFileRoute("/databases/custom/$name")({});
