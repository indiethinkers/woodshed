"use client";

import { useQuery } from "@tanstack/react-query";
import {
  type AgentRun,
  listActiveAgentRuns,
} from "@/lib/agent/transport";

export const ACTIVE_AGENT_RUNS_QUERY_KEY = ["agent", "runs", "active"] as const;

export function useActiveAgentRuns(enabled = true) {
  return useQuery<AgentRun[]>({
    queryKey: ACTIVE_AGENT_RUNS_QUERY_KEY,
    queryFn: listActiveAgentRuns,
    enabled,
    refetchInterval: 1_500,
    refetchIntervalInBackground: false,
  });
}
