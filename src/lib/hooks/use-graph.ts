"use client";

import { useQuery } from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";

// Mirrors the Rust GraphSnapshot shape (src-tauri/src/index/mod.rs).
export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  href?: string | null;
  area?: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const GRAPH_KEY = ["graph"] as const;

// Browser-only fallback (vitest / `bun run dev` without a Tauri runtime):
// a tiny synthetic vault so the Graph view renders something meaningful
// instead of an empty canvas.
const DEMO_SNAPSHOT: GraphSnapshot = {
  nodes: [
    {
      id: "notebook/seed-investor-memo.md",
      label: "Seed investor memo",
      kind: "note",
      href: "/notebook/seed-investor-memo",
      area: "fundraise",
    },
    {
      id: "notebook/local-first.md",
      label: "Local-first, explained",
      kind: "note",
      href: "/notebook/local-first",
      area: "product",
    },
    {
      id: "people/tomas-bergstrom.md",
      label: "Tomas Bergström",
      kind: "person",
      href: "/people/tomas-bergstrom",
    },
    {
      id: "people/elliot-park.md",
      label: "Elliot Park",
      kind: "person",
      href: "/people/elliot-park",
    },
    {
      id: "tasks/improve-onboarding.md",
      label: "Improve onboarding",
      kind: "task",
      href: "/tables/tasks?focus=improve-onboarding",
      area: "product",
    },
    {
      id: "areas/fundraise.md",
      label: "Fundraise",
      kind: "area",
      href: "/areas/fundraise",
    },
    {
      id: "events/demo-day.md",
      label: "Demo day",
      kind: "event",
      href: "/cadence/event/demo-day",
      area: "fundraise",
    },
    {
      id: "unresolved:Retention: what the number actually says",
      label: "Retention: what the number actually says",
      kind: "unresolved",
    },
  ],
  edges: [
    {
      source: "notebook/seed-investor-memo.md",
      target: "people/tomas-bergstrom.md",
    },
    {
      source: "notebook/seed-investor-memo.md",
      target: "notebook/local-first.md",
    },
    {
      source: "notebook/seed-investor-memo.md",
      target: "areas/fundraise.md",
    },
    {
      source: "notebook/seed-investor-memo.md",
      target: "events/demo-day.md",
    },
    {
      source: "notebook/seed-investor-memo.md",
      target: "unresolved:Retention: what the number actually says",
    },
    {
      source: "notebook/local-first.md",
      target: "tasks/improve-onboarding.md",
    },
    {
      source: "notebook/local-first.md",
      target: "people/elliot-park.md",
    },
    {
      source: "events/demo-day.md",
      target: "people/elliot-park.md",
    },
  ],
};

/**
 * Fetches the full vault wikilink graph (nodes + edges + unresolved link
 * placeholders) from the Rust index in one round-trip. Keyed on the same
 * `["graph"]` cache the vault-events listener invalidates on any change.
 */
export function useGraph() {
  return useQuery<GraphSnapshot>({
    queryKey: GRAPH_KEY,
    queryFn: async () => {
      const snapshot = await tauriInvoke<GraphSnapshot>("wikilink_graph");
      // Browser-only fallback so the surface still renders in tests and in
      // `bun run dev` without a Tauri backend.
      return snapshot ?? DEMO_SNAPSHOT;
    },
    // staleTime: Infinity — the vault-events listener invalidates this key on
    // every file change; there is no polling.
    staleTime: Infinity,
  });
}
