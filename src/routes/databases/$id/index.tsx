import { createFileRoute } from "@tanstack/react-router";

// Eager metadata only — TableView (with its board/calendar/gallery
// view siblings and tanstack-table dep) loads from the .lazy sibling
// on first visit.
export const Route = createFileRoute("/databases/$id/")({});
