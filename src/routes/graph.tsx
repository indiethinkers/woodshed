import { createFileRoute } from "@tanstack/react-router";
import { GraphView } from "@/components/graph/graph-view";

export const Route = createFileRoute("/graph")({
  component: GraphPage,
});

// The graph is a canvas surface, not a document — it owns the whole content
// area (no list panel, no breadcrumb) and draws its own toolbar.
function GraphPage() {
  return (
    <div
      className="relative h-full min-h-0 min-w-0 flex-1 bg-content"
      data-woodshed-content-panel=""
      data-woodshed-surface="graph"
    >
      <GraphView />
    </div>
  );
}
