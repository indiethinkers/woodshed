import type { DynamicToolUIPart } from "ai";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentThoughtTool, AgentWorkIndicator } from "./agent-surface";

describe("AgentWorkIndicator", () => {
  it("renders a compact working chip without the heavy step queue", () => {
    render(<AgentWorkIndicator displayName="Cadence" />);

    expect(screen.getByText("Cadence is working")).toBeInTheDocument();
    // The old, oversized Plan/Queue treatment is gone.
    expect(screen.queryByText("3 steps")).not.toBeInTheDocument();
    expect(screen.queryByText("Remote agent work")).not.toBeInTheDocument();
    expect(screen.queryByText("Response stream")).not.toBeInTheDocument();
  });
});

describe("AgentThoughtTool", () => {
  it("renders a friendly activity line and reveals parameters on expand", () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "search_vault",
      toolCallId: "call_1",
      state: "input-available",
      input: { query: "Hermes" },
    };

    render(<AgentThoughtTool part={part} />);

    // Inferred verb + the query surfaced as a detail line.
    expect(screen.getByText("Searching your vault")).toBeInTheDocument();
    expect(screen.getByText("Hermes")).toBeInTheDocument();
    // Detail stays collapsed until the step is opened.
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Searching your vault"));

    expect(screen.getByText("Parameters")).toBeInTheDocument();
  });

  it("auto-expands approval requests with actionable confirmation controls", () => {
    const onApproval = vi.fn();
    const part = {
      type: "dynamic-tool",
      toolName: "archive_mail",
      toolCallId: "call_approve",
      state: "approval-requested",
      approval: { id: "approval_1" },
      input: { messageId: "msg_1" },
    } as DynamicToolUIPart;

    render(<AgentThoughtTool onToolApprovalResponse={onApproval} part={part} />);

    expect(screen.getByText("Working with mail")).toBeInTheDocument();
    expect(screen.getByText("Tool approval")).toBeInTheDocument();
    expect(screen.getByText("archive_mail")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onApproval).toHaveBeenCalledWith({
      approved: true,
      id: "approval_1",
    });
  });
});
