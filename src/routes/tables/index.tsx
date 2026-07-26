import { createFileRoute } from "@tanstack/react-router";

// Stub so `/tables` matches and the parent redirect (tables.tsx) fires.
export const Route = createFileRoute("/tables/")({});
