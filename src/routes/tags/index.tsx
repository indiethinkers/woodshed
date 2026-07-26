import { createFileRoute } from "@tanstack/react-router";

// Stub so `/tags` matches and the parent redirect (tags.tsx) fires.
export const Route = createFileRoute("/tags/")({});
