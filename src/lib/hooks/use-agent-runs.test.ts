import { describe, expect, it } from "vitest";
import type { AgentRun } from "@/lib/agent/transport";
import { updateAgentConversationRuns } from "./use-agent-runs";

function syntheticRun(index: number): AgentRun {
  const suffix = String(index).padStart(2, "0");
  return {
    id: `agent-run-${suffix}`,
    conversationId: "agent-conversation-synthetic",
    sessionId: "agent-conversation-synthetic",
    assistantMessageId: `assistant-message-${suffix}`,
    status: "completed",
    createdAt: `2031-02-03T12:${suffix}:00Z`,
    updatedAt: `2031-02-03T12:${suffix}:01Z`,
    startedAt: `2031-02-03T12:${suffix}:00Z`,
    finishedAt: `2031-02-03T12:${suffix}:01Z`,
    inputMessage: {
      id: `user-message-${suffix}`,
      role: "user",
      createdAt: `2031-02-03T12:${suffix}:00Z`,
      content: "Review the synthetic reference.",
    },
    events: [],
    finalResponse: "Synthetic response.",
    error: null,
    retryOf: null,
  };
}

describe("updateAgentConversationRuns", () => {
  it("retains complete activity history beyond twenty turns", () => {
    const runs = Array.from({ length: 25 }, (_, index) =>
      syntheticRun(index),
    ).reduce<AgentRun[]>(updateAgentConversationRuns, []);

    expect(runs).toHaveLength(25);
    expect(runs[0].id).toBe("agent-run-24");
    expect(runs.at(-1)?.id).toBe("agent-run-00");
  });
});
