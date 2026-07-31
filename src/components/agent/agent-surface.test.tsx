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
  resumeStream: vi.fn().mockResolvedValue(undefined),
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
    if (command === "agent_chats_all") {
      return [
        {
          id: "agent-conversation-1",
          path: "agent/agent-conversation-1.md",
          title: "Reference review",
          agent: "Hermes",
          model: "synthetic-model",
          created: "2031-02-03T12:00:00Z",
          updated: "2031-02-03T12:00:00Z",
          lastMessageCreated: null,
          pinned: false,
          messageCount: 0,
          preview: "",
        },
      ];
    }
    if (command === "agent_chat_get") {
      return {
        id: "agent-conversation-1",
        path: "agent/agent-conversation-1.md",
        title: "Reference review",
        agent: "Hermes",
        model: "synthetic-model",
        created: "2031-02-03T12:00:00Z",
        updated: "2031-02-03T12:00:00Z",
        pinned: false,
        tags: ["agent"],
        messages: [],
      };
    }
    return null;
  }),
}));

import {
  AgentSurface,
  AgentRunBanner,
  AgentThoughtTool,
  AgentWorkIndicator,
  toUiMessages,
} from "./agent-surface";
import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import type { AgentRun } from "@/lib/agent/transport";

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

  it("keeps the main composer radius while removing only the inner fill", async () => {
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

    const textarea = await screen.findByPlaceholderText(
      "How can I help you today?",
    );
    const composer = textarea.closest("form");

    expect(composer).toHaveClass(
      "rounded-[14px]",
      "[&>[data-slot=input-group]]:!bg-transparent",
    );
    expect(composer).not.toHaveClass("rounded-full");
  });

  it("asks the transport to reconnect after hydrating an existing chat", async () => {
    window.localStorage.setItem(
      "woodshed:agent:last-chat-id",
      JSON.stringify({ id: "agent-conversation-1", at: Date.now() }),
    );
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
      expect(chatMock.resumeStream).toHaveBeenCalled();
    });
    window.localStorage.removeItem("woodshed:agent:last-chat-id");
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

describe("AgentRunBanner", () => {
  it("offers an explicit retry for a failed durable run", () => {
    const onRetry = vi.fn();
    const failedRun: AgentRun = {
      id: "agent-run-failed",
      conversationId: "agent-conversation-1",
      sessionId: "agent-conversation-1",
      assistantMessageId: "agent-response-failed",
      status: "failed",
      createdAt: "2031-02-03T12:00:00Z",
      updatedAt: "2031-02-03T12:00:02Z",
      startedAt: "2031-02-03T12:00:01Z",
      finishedAt: "2031-02-03T12:00:02Z",
      inputMessage: {
        id: "message-1",
        role: "user",
        createdAt: "2031-02-03T12:00:00Z",
        content: "Review the reference.",
      },
      events: [],
      finalResponse: null,
      error: "The local agent was unavailable.",
      retryOf: null,
    };

    render(<AgentRunBanner onRetry={onRetry} run={failedRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByText("The local agent was unavailable.")).toBeInTheDocument();
  });
});

describe("persisted agent attachments", () => {
  it("restores attachment context as a file part instead of message text", () => {
    const [message] = toUiMessages([
      {
        id: "message-1",
        role: "user",
        createdAt: "2031-02-03T12:00:00Z",
        content:
          "Review this reference.\n\nAttachments:\n- sample-diagram.png (image/png)",
      },
    ]);

    expect(message.parts).toEqual([
      { type: "text", text: "Review this reference." },
      {
        type: "file",
        filename: "sample-diagram.png",
        mediaType: "image/png",
        url: "",
      },
    ]);
  });

  it("restores attachment-only messages with multiple file shapes", () => {
    const [message] = toUiMessages([
      {
        id: "message-2",
        role: "user",
        createdAt: "2031-02-03T12:05:00Z",
        content:
          "Attachments:\n- sample-photo.jpg (image/jpeg)\n- reference-notes.txt",
      },
    ]);

    expect(message.parts).toEqual([
      {
        type: "file",
        filename: "sample-photo.jpg",
        mediaType: "image/jpeg",
        url: "",
      },
      {
        type: "file",
        filename: "reference-notes.txt",
        mediaType: undefined,
        url: "",
      },
    ]);
  });

  it("leaves malformed attachment-like prose as message text", () => {
    const content = "Review these notes.\n\nAttachments:\nnot a file entry";
    const [message] = toUiMessages([
      {
        id: "message-3",
        role: "user",
        createdAt: "2031-02-03T12:10:00Z",
        content,
      },
    ]);

    expect(message.parts).toEqual([{ type: "text", text: content }]);
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
