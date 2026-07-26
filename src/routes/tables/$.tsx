import { createFileRoute } from "@tanstack/react-router";

// Splat stub so deep `/tables/<anything>` links match and the parent redirect
// (tables.tsx) fires, rewriting them to `/databases/<anything>`.
export const Route = createFileRoute("/tables/$")({});
