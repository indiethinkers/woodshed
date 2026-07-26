import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy redirect. Generated tag tables moved under the Databases surface
// (June 2026): `/tags/<tag>` → `/databases/tags/<tag>`, and the old `/tags`
// index is covered by the Databases index table, so bare `/tags` →
// `/databases`. As the parent of the `/tags/` index and `/tags/$` splat
// stubs, this beforeLoad runs first for every `/tags*` match and
// short-circuits before anything renders (search params preserved).
export const Route = createFileRoute("/tags")({
  beforeLoad: ({ location }) => {
    throw redirect({
      href:
        location.pathname === "/tags" || location.pathname === "/tags/"
          ? "/databases"
          : location.href.replace(/^\/tags/, "/databases/tags"),
      replace: true,
    });
  },
});
