import { createFileRoute } from "@tanstack/react-router";
import { AgentSurface } from "@/components/agent/agent-surface";

export const Route = createFileRoute("/agent")({
  component: AgentRoute,
});

function AgentRoute() {
  return <AgentSurface />;
}
