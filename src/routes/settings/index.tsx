import { createFileRoute, redirect } from "@tanstack/react-router";

// /settings has no content of its own — it redirects to the first
// section. beforeLoad runs before the route mounts, so the user never
// sees an empty pane on the way through.
export const Route = createFileRoute("/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/vault" });
  },
});
