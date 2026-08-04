"use client";

import { useQuery } from "@tanstack/react-query";
import {
  type AgentRun,
  listActiveAgentRuns,
  listAgentRunsByIds,
} from "@/lib/agent/transport";

export const ACTIVE_AGENT_RUNS_QUERY_KEY = ["agent", "runs", "active"] as const;

export function agentConversationRunsQueryKeyPrefix(conversationId: string) {
  return ["agent", "runs", "conversation", conversationId] as const;
}

export function agentConversationRunsQueryKey(
  conversationId: string,
  runIds: string[],
) {
  return [...agentConversationRunsQueryKeyPrefix(conversationId), runIds] as const;
}

export function useActiveAgentRuns(enabled = true) {
  return useQuery<AgentRun[]>({
    queryKey: ACTIVE_AGENT_RUNS_QUERY_KEY,
    queryFn: listActiveAgentRuns,
    enabled,
    refetchInterval: 1_500,
    refetchIntervalInBackground: false,
  });
}

export function useAgentConversationRuns(
  conversationId: string | null,
  runIds: string[],
  enabled = true,
) {
  return useQuery<AgentRun[]>({
    queryKey: agentConversationRunsQueryKey(
      conversationId ?? "inactive",
      runIds,
    ),
    queryFn: () =>
      conversationId ? listAgentRunsByIds(conversationId, runIds) : [],
    enabled: enabled && Boolean(conversationId),
    refetchOnMount: "always",
  });
}

export function updateAgentConversationRuns(
  runs: AgentRun[] | undefined,
  next: AgentRun,
): AgentRun[] {
  const current = runs?.find((run) => run.id === next.id);
  if (
    current === next ||
    (current?.updatedAt === next.updatedAt &&
      current.status === next.status &&
      current.events.length === next.events.length)
  ) {
    return runs ?? [];
  }
  return [next, ...(runs ?? []).filter((run) => run.id !== next.id)].sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  );
}
