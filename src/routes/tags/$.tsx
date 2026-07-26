import { createFileRoute } from "@tanstack/react-router";

// Splat stub so deep `/tags/<anything>` links match and the parent redirect
// (tags.tsx) fires, rewriting them to `/databases/tags/<anything>`.
export const Route = createFileRoute("/tags/$")({});
