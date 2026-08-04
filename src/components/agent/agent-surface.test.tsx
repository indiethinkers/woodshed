import type { DynamicToolUIPart, UIMessage } from "ai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  AgentBackgroundQueue,
  AgentContextUsage,
  AgentSurface,
  AgentMessage,
  AgentRunBanner,
  AgentThoughtTool,
  AgentWorkIndicator,
  sortChatsByCreatedAt,
  toUiMessages,
} from "./agent-surface";
import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import type { AgentRun } from "@/lib/agent/transport";

function syntheticRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "agent-run-synthetic",
    conversationId: "agent-conversation-1",
    sessionId: "agent-conversation-1",
    assistantMessageId: "agent-response-synthetic",
    status: "running",
    createdAt: "2031-02-03T12:00:00Z",
    updatedAt: "2031-02-03T12:00:01Z",
    startedAt: "2031-02-03T12:00:01Z",
    finishedAt: null,
    inputMessage: {
      id: "message-1",
      role: "user",
      createdAt: "2031-02-03T12:00:00Z",
      content: "Review the synthetic reference.",
    },
    events: [],
    finalResponse: null,
    error: null,
    retryOf: null,
    ...overrides,
  };
}

describe("Agent conversation ordering", () => {
  it("sorts chats by creation time descending even when an older chat was updated later", () => {
    const sorted = sortChatsByCreatedAt([
      {
        id: "older-chat",
        path: "agent/older-chat.md",
        title: "Older chat",
        agent: "Hermes",
        model: "synthetic-model",
        created: "2031-02-03T12:00:00Z",
        updated: "2031-02-03T15:00:00Z",
        lastMessageCreated: "2031-02-03T15:00:00Z",
        pinned: false,
        messageCount: 3,
        preview: "Older chat received a later reply.",
      },
      {
        id: "newer-chat",
        path: "agent/newer-chat.md",
        title: "Newer chat",
        agent: "Hermes",
        model: "synthetic-model",
        created: "2031-02-03T14:00:00Z",
        updated: "2031-02-03T14:00:00Z",
        lastMessageCreated: "2031-02-03T14:00:00Z",
        pinned: false,
        messageCount: 1,
        preview: "Newer chat.",
      },
    ]);

    expect(sorted.map((chat) => chat.id)).toEqual(["newer-chat", "older-chat"]);
  });

  it("uses the chat id as a deterministic tie-breaker", () => {
    const shared = {
      path: "agent/synthetic-chat.md",
      title: "Same title",
      agent: "Hermes",
      model: "synthetic-model",
      created: "invalid",
      updated: "2031-02-03T14:00:00Z",
      lastMessageCreated: null,
      pinned: false,
      messageCount: 0,
      preview: "",
    };

    const sorted = sortChatsByCreatedAt([
      { ...shared, id: "chat-z" },
      { ...shared, id: "chat-a" },
    ]);

    expect(sorted.map((chat) => chat.id)).toEqual(["chat-a", "chat-z"]);
  });
});

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

describe("AgentMessage activity state", () => {
  it("repairs incomplete Markdown while an assistant response is streaming", () => {
    const { container } = render(
      <AgentMessage
        displayName="Hermes"
        isFirst
        isLastMessage
        isStreaming
        message={{
          id: "assistant-streaming",
          role: "assistant",
          parts: [{ type: "text", text: "**Streaming response" }],
        }}
        onToolApprovalResponse={vi.fn()}
      />,
    );

    expect(screen.getByText("Streaming response")).toBeInTheDocument();
    expect(container.textContent).not.toContain("**");
  });

  it("does not reparse an unchanged prior message when its parent rerenders", () => {
    const parts: UIMessage["parts"] = [
      { type: "text", text: "A stable synthetic response." },
    ];
    let partReads = 0;
    const message = {
      id: "assistant-stable",
      role: "assistant",
    } as UIMessage;
    Object.defineProperty(message, "parts", {
      get() {
        partReads += 1;
        return parts;
      },
    });
    const onToolApprovalResponse = vi.fn();
    const props = {
      displayName: "Hermes",
      isFirst: true,
      isLastMessage: false,
      isStreaming: true,
      message,
      onToolApprovalResponse,
    };
    const { rerender } = render(<AgentMessage {...props} />);
    const initialPartReads = partReads;

    rerender(<AgentMessage {...props} />);

    expect(partReads).toBe(initialPartReads);
  });

  it("shows a compact non-collapsible wait state before meaningful activity arrives", () => {
    render(
      <AgentMessage
        displayName="Hermes"
        isFirst
        isLastMessage
        isStreaming
        message={{ id: "assistant-1", role: "assistant", parts: [] }}
        onToolApprovalResponse={vi.fn()}
      />,
    );

    const status = screen.getByText("Hermes is working");
    expect(status.closest("button")).toBeNull();
    expect(screen.queryByText("Working remotely")).not.toBeInTheDocument();
    expect(screen.queryByText("Sent context to Hermes")).not.toBeInTheDocument();
  });

  it("promotes a prolonged silent wait into an honest Hermes activity log", () => {
    vi.useFakeTimers();
    try {
      render(
        <AgentMessage
          displayName="Hermes"
          isFirst
          isLastMessage
          isStreaming
          message={{ id: "assistant-1", role: "assistant", parts: [] }}
          onToolApprovalResponse={vi.fn()}
        />,
      );

      expect(screen.queryByText("Sent context to Hermes")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(3_999));
      expect(screen.queryByText("Sent context to Hermes")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));

      expect(screen.getByText("Sent context to Hermes")).toBeInTheDocument();
      expect(screen.getAllByText("Waiting for Hermes")).toHaveLength(2);
      expect(
        screen.getByText("No reasoning or tool activity has arrived yet."),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens an event-driven activity log when a real tool starts", () => {
    render(
      <AgentMessage
        displayName="Hermes"
        isFirst
        isLastMessage
        isStreaming
        message={{
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "search_vault",
              toolCallId: "call_1",
              state: "input-available",
              input: { query: "synthetic notes" },
            },
          ],
        }}
        onToolApprovalResponse={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Searching your vault")).toHaveLength(2);
    expect(screen.getByText("synthetic notes")).toBeInTheDocument();
  });

  it("renders reasoning summaries that Hermes explicitly streams", () => {
    render(
      <AgentMessage
        displayName="Hermes"
        isFirst
        isLastMessage
        isStreaming
        message={{
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              text: "Checking the supplied context before answering.",
              state: "streaming",
            },
          ],
        }}
        onToolApprovalResponse={vi.fn()}
      />,
    );

    expect(screen.getByText("Thinking through the response")).toBeInTheDocument();
    expect(screen.queryByText("Reasoned through it")).not.toBeInTheDocument();
    expect(
      screen.getByText("Checking the supplied context before answering."),
    ).toBeInTheDocument();
  });

  it("stops labeling completed reasoning as live while response text streams", () => {
    render(
      <AgentMessage
        displayName="Hermes"
        isFirst
        isLastMessage
        isStreaming
        message={{
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              text: "Checked the supplied context.",
              state: "done",
            },
            { type: "text", text: "Streaming the answer.", state: "streaming" },
          ],
        }}
        onToolApprovalResponse={vi.fn()}
      />,
    );

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.queryByText("Thinking through the response")).not.toBeInTheDocument();
  });
});

describe("Agent background work", () => {
  it("shows durable runs from other conversations and opens the selected chat", () => {
    const onSelect = vi.fn();
    render(
      <AgentBackgroundQueue
        chats={[
          {
            id: "agent-conversation-2",
            path: "agent/agent-conversation-2.md",
            title: "Background research",
            agent: "Hermes",
            model: "synthetic-model",
            created: "2031-02-03T12:00:00Z",
            updated: "2031-02-03T12:00:01Z",
            lastMessageCreated: null,
            pinned: false,
            messageCount: 1,
            preview: "Synthetic preview.",
          },
        ]}
        onSelect={onSelect}
        runs={[
          syntheticRun({
            id: "agent-run-background",
            conversationId: "agent-conversation-2",
            sessionId: "agent-conversation-2",
          }),
        ]}
      />,
    );

    expect(screen.getByText("1 background run")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /1 background run/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Background research" }));
    expect(onSelect).toHaveBeenCalledWith("agent-conversation-2");
  });

  it("shows token usage only when Hermes provides it", () => {
    const run = syntheticRun({
      status: "completed",
      events: [
        {
          kind: "usage",
          usage: {
            inputTokens: 1200,
            outputTokens: 345,
            reasoningTokens: 45,
            cachedInputTokens: 200,
            totalTokens: 1545,
          },
        },
      ],
    });

    const { rerender } = render(<AgentContextUsage run={run} />);
    expect(screen.getByRole("button", { name: "1.5K tokens used" })).toBeInTheDocument();

    rerender(<AgentContextUsage run={syntheticRun()} />);
    expect(screen.queryByRole("button", { name: /tokens used/ })).not.toBeInTheDocument();
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
  it("preserves a loaded attachment URL while hydrating the completed turn", () => {
    const [message] = toUiMessages(
      [
        {
          id: "message-1",
          role: "user",
          createdAt: "2031-02-03T12:00:00Z",
          content:
            "Review this reference.\n\nAttachments:\n- sample-review.pdf (application/pdf)",
        },
      ],
      [
        {
          id: "message-1",
          role: "user",
          parts: [
            { type: "text", text: "Review this reference." },
            {
              type: "file",
              filename: "sample-review.pdf",
              mediaType: "application/pdf",
              url: "data:application/pdf;base64,JVBERi0xLjQK",
            },
          ],
        },
      ],
      {
        hydratedChatId: "chat-1",
        loadedChatId: "chat-1",
      },
    );

    expect(message.parts).toEqual([
      { type: "text", text: "Review this reference." },
      {
        type: "file",
        filename: "sample-review.pdf",
        mediaType: "application/pdf",
        url: "data:application/pdf;base64,JVBERi0xLjQK",
      },
    ]);
  });

  it("does not restore an attachment URL from a different chat", () => {
    const [message] = toUiMessages(
      [
        {
          id: "message-1",
          role: "user",
          createdAt: "2031-02-03T12:00:00Z",
          content:
            "Review this reference.\n\nAttachments:\n- sample-review.pdf (application/pdf)",
        },
      ],
      [
        {
          id: "message-1",
          role: "user",
          parts: [
            { type: "text", text: "Review this reference." },
            {
              type: "file",
              filename: "sample-review.pdf",
              mediaType: "application/pdf",
              url: "data:application/pdf;base64,DIFFERENT_CHAT",
            },
          ],
        },
      ],
      {
        hydratedChatId: "chat-2",
        loadedChatId: "chat-1",
      },
    );

    expect(message.parts).toEqual([
      { type: "text", text: "Review this reference." },
      {
        type: "file",
        filename: "sample-review.pdf",
        mediaType: "application/pdf",
        url: "",
      },
    ]);
  });

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
  it("renders a structured update-plan tool as a plan", () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "update_plan",
      toolCallId: "call_plan",
      state: "input-available",
      input: {
        plan: [
          { step: "Inspect the synthetic input", status: "completed" },
          { step: "Draft the response", status: "in_progress" },
        ],
      },
    };

    render(<AgentThoughtTool part={part} />);

    expect(screen.getByText("Implementation plan")).toBeInTheDocument();
    expect(screen.getByText("Inspect the synthetic input")).toBeInTheDocument();
    expect(screen.getByText("Draft the response")).toBeInTheDocument();
  });

  it("preserves approval controls for structured plans", () => {
    const onApproval = vi.fn();
    const part = {
      type: "dynamic-tool",
      toolName: "update_plan",
      toolCallId: "call_plan",
      state: "approval-requested",
      approval: { id: "approval_plan" },
      input: {
        plan: [{ step: "Inspect the synthetic input", status: "pending" }],
      },
    } as DynamicToolUIPart;

    render(<AgentThoughtTool onToolApprovalResponse={onApproval} part={part} />);

    expect(screen.getByText("Implementation plan")).toBeInTheDocument();
    expect(screen.getByText("Tool approval")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApproval).toHaveBeenCalledWith({
      approved: true,
      id: "approval_plan",
    });
  });

  it("preserves errors for structured plans", () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "update_plan",
      toolCallId: "call_plan",
      state: "output-error",
      input: {
        plan: [{ step: "Inspect the synthetic input", status: "pending" }],
      },
      errorText: "Synthetic plan error.",
    };

    render(<AgentThoughtTool part={part} />);

    expect(screen.getByText("Implementation plan")).toBeInTheDocument();
    expect(screen.getByText("Synthetic plan error.")).toBeInTheDocument();
  });

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
