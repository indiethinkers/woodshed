import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy redirect. The module was renamed Tables → Databases (May/June 2026)
// and its routes moved to `/databases`. Any old `/tables*` link — a bookmark,
// a wikilink, a tab restored from history — lands here and is rewritten to the
// equivalent `/databases*` path (search params preserved). As the parent of
// the `/tables/` index and `/tables/$` splat stubs, this beforeLoad runs first
// for every `/tables*` match and short-circuits before anything renders.
export const Route = createFileRoute("/tables")({
  beforeLoad: ({ location }) => {
    throw redirect({
      href: location.href.replace(/^\/tables/, "/databases"),
      replace: true,
    });
  },
});
