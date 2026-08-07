"use client";

import { useNavigate } from "@tanstack/react-router";
import { useActiveAgentRuns } from "@/lib/hooks/use-agent-runs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const railButtonClass =
  "relative h-8 w-8 rounded-lg flex items-center justify-center transition-colors";

// Pulsing dot that appears in the sidebar rail while any agent run is
// queued or running. Driven by the durable agent-runs records (polled
// every 1.5s), so it survives navigation away from the Agent surface and
// reappears when the user comes back — the run keeps going whether or not
// its chat is visible. Clicking jumps to the Agent surface, where the run's
// progress and the background-run queue are rendered. No UI when idle.
export function AgentWorkingIndicator() {
  const navigate = useNavigate();
  const { data: activeRuns = [] } = useActiveAgentRuns(true);
  const working = activeRuns.some(
    (run) => run.status === "queued" || run.status === "running",
  );

  if (!working) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => navigate({ to: "/agent" })}
            aria-label="Cadence is working"
            data-woodshed-action="navigate:agent-working"
            className={`${railButtonClass} text-muted-foreground hover:text-foreground hover:bg-accent`}
          />
        }
      >
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-blue-500 ring-2 ring-rail animate-pulse dark:bg-blue-400"
        />
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        Cadence is working…
      </TooltipContent>
    </Tooltip>
  );
}
