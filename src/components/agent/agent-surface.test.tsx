import type { DynamicToolUIPart } from "ai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const chatMock = vi.hoisted(() => ({
  addToolApprovalResponse: vi.fn(),
  error: undefined,
  messages: [],
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  status: "ready",
  stop: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@ai-sdk/react", () => ({
  useChat: () => chatMock,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Link: ({ children, ...props }: React.ComponentProps<"a">) => (
      <a {...props}>{children}</a>
    ),
    useNavigate: () => navigateMock,
    useRouterState: () => "/agent",
  };
});

vi.mock("@/lib/hooks/use-vault-path", () => ({
  useVaultPath: () => ({ data: "/tmp/vault" }),
}));

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: vi.fn(async (command: string) => {
    if (command === "agent_config_get") {
      return {
        baseUrl: "http://127.0.0.1:9000/v1",
        displayName: "Hermes",
        hasApiKey: true,
        model: "synthetic-model",
        sessionKey: "",
      };
    }
    if (command === "agent_chats_all") return [];
    return null;
  }),
}));

import {
  AgentSurface,
  AgentThoughtTool,
  AgentWorkIndicator,
} from "./agent-surface";
import { PromptInputProvider } from "@/components/ai-elements/prompt-input";

describe("AgentSurface voice controls", () => {
  it("does not expose dictation or voice conversation controls", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PromptInputProvider>
          <AgentSurface />
        </PromptInputProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Hermes" })).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Dictate" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start voice conversation" }),
    ).not.toBeInTheDocument();
  });
});

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
