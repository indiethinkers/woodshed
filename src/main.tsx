import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";

// Self-hosted Inter Variable — replaces next/font/google. The face name
// is "Inter Variable", wired into --font-inter in styles.css.
import "@fontsource-variable/inter";

import { routeTree } from "./routeTree.gen";
import { runtime } from "./lib/runtime";
import { NotFound } from "./components/layout/not-found";
import "./styles.css";

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  // Unmatched routes (renamed/deleted records, stale history entries) render
  // a recoverable "Page not found" inside the shell instead of a blank body.
  defaultNotFoundComponent: NotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing in index.html");

document.documentElement.dataset.woodshedRuntime = runtime();

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
