import type { DynamicToolUIPart, UIMessage } from "ai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const routerMock = vi.hoisted(() => ({ href: "/agent" }));
const invokeMock = vi.hoisted(() => ({
  agentConfig: {
    baseUrl: "http://127.0.0.1:9000/v1",
    credentialSource: "hermes",
    displayName: "Hermes",
    hasApiKey: true,
    managedProfile: null as null | {
      available: boolean;
      model: string;
      name: string;
      port: number;
    },
    model: "synthetic-model",
    sessionKey: "",
  },
  chatMessages: [] as Array<{
    agentRunId?: string | null;
    content: string;
    createdAt: string;
    id: string;
    role: "system" | "user" | "assistant";
  }>,
  chatModel: "synthetic-model",
  chatListPromise: null as Promise<unknown[]> | null,
  agentConfigError: null as Error | null,
  agentConfigPromise: null as Promise<unknown> | null,
  attachmentPrepareError: null as Error | null,
}));
const tauriInvokeMock = vi.hoisted(() => vi.fn());

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
    useRouterState: () => routerMock.href,
  };
});

vi.mock("@/lib/hooks/use-vault-path", () => ({
  useVaultPath: () => ({ data: "/tmp/vault" }),
}));

vi.mock("@/lib/runtime", () => ({
  isTauriRuntime: () => true,
}));

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: tauriInvokeMock,
}));

import {
  AgentBackgroundQueue,
  AgentContextUsage,
  AgentHeader,
  AgentSurface,
  AgentMessage,
  AgentRunBanner,
  AgentThoughtTool,
  AgentWorkIndicator,
  conversationAutoTitle,
  isAutoDerivedTitle,
  isScrollContainerPinned,
  mergeHydratedConversationMessages,
  modelForAgentChatUpdate,
  sortChatsByCreatedAt,
  toUiMessages,
} from "./agent-surface";
import { weatherPreviewFromResponse } from "./agent-weather-response";
import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import type { AgentRun } from "@/lib/agent/transport";

beforeEach(() => {
  chatMock.error = undefined;
  chatMock.messages = [];
  chatMock.status = "ready";
  chatMock.sendMessage.mockReset();
  chatMock.setMessages.mockReset();
  chatMock.setMessages.mockImplementation((next) => {
    chatMock.messages =
      typeof next === "function" ? next(chatMock.messages) : next;
  });
  chatMock.resumeStream.mockReset();
  chatMock.resumeStream.mockResolvedValue(undefined);
  invokeMock.agentConfig = {
    baseUrl: "http://127.0.0.1:9000/v1",
    credentialSource: "hermes",
    displayName: "Hermes",
    hasApiKey: true,
    managedProfile: null,
    model: "synthetic-model",
    sessionKey: "",
  };
  invokeMock.chatMessages = [];
  invokeMock.chatModel = "synthetic-model";
  invokeMock.chatListPromise = null;
  invokeMock.agentConfigError = null;
  invokeMock.agentConfigPromise = null;
  invokeMock.attachmentPrepareError = null;
  tauriInvokeMock.mockReset();
  tauriInvokeMock.mockImplementation(async (command: string) => {
    if (command === "agent_config_get") {
      if (invokeMock.agentConfigError) throw invokeMock.agentConfigError;
      if (invokeMock.agentConfigPromise) return invokeMock.agentConfigPromise;
      return invokeMock.agentConfig;
    }
    if (command === "agent_attachment_prepare") {
      if (invokeMock.attachmentPrepareError) {
        throw invokeMock.attachmentPrepareError;
      }
      return { context: "[Attachment: synthetic prepared text]" };
    }
    if (command === "agent_chats_all") {
      return (
        invokeMock.chatListPromise ?? [
          {
            id: "agent-conversation-1",
            path: "agent/agent-conversation-1.md",
            title: "Reference review",
            agent: "Hermes",
            model: invokeMock.chatModel,
            created: "2031-02-03T12:00:00Z",
            updated: "2031-02-03T12:00:00Z",
            lastMessageCreated: null,
            pinned: false,
            messageCount: 0,
            preview: "",
          },
        ]
      );
    }
    if (command === "agent_chat_get") {
      return {
        id: "agent-conversation-1",
        path: "agent/agent-conversation-1.md",
        title: "Reference review",
        agent: "Hermes",
        model: invokeMock.chatModel,
        created: "2031-02-03T12:00:00Z",
        updated: "2031-02-03T12:00:00Z",
        pinned: false,
        tags: ["agent"],
        messages: invokeMock.chatMessages,
      };
    }
    return null;
  });
  routerMock.href = "/agent";
  navigateMock.mockClear();
});

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
  it("keeps the conversation list visible when starting a new chat", async () => {
    routerMock.href = "/agent?chat=agent-conversation-1";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const surface = (
      <QueryClientProvider client={queryClient}>
        <PromptInputProvider>
          <AgentSurface />
        </PromptInputProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(surface);

    expect(await screen.findByText("Reference review")).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      routerMock.href = "/agent";
      rerender(surface);
      await Promise.resolve();
    });

    expect(screen.getByText("Reference review")).toBeVisible();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("does not restore an old chat when New chat wins a slow initial load", async () => {
    let resolveChats: (value: unknown[]) => void = () => {};
    invokeMock.chatListPromise = new Promise((resolve) => {
      resolveChats = resolve;
    });
    routerMock.href = "/agent?chat=agent-conversation-1";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const surface = (
      <QueryClientProvider client={queryClient}>
        <PromptInputProvider>
          <AgentSurface />
        </PromptInputProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(surface);

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    routerMock.href = "/agent";
    rerender(surface);

    await act(async () => {
      resolveChats([
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
      ]);
    });

    const rowButton = await screen.findByRole("button", {
      name: "Reference review",
    });
    expect(rowButton.parentElement).not.toHaveClass("bg-muted");
  });

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
      expect(
        screen.getByRole("heading", { name: "Hermes" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: "Dictate" }),
    ).not.toBeInTheDocument();
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

  it("accepts a supported image attachment", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:synthetic-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    try {
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

      await screen.findByPlaceholderText("How can I help you today?");
      fireEvent.change(screen.getByLabelText("Upload files"), {
        target: {
          files: [
            new File(["synthetic image"], "reference.png", {
              type: "image/png",
            }),
          ],
        },
      });

      expect(await screen.findByText("reference.png")).toBeInTheDocument();
      expect(
        screen.queryByText(
          "Agent attachments support images, PDF, Office documents, and text files.",
        ),
      ).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
    }
  });

  it("preserves a supported attachment when preparation fails before send", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:synthetic-pdf"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    try {
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
      fireEvent.change(textarea, { target: { value: "Read this reference." } });
      fireEvent.change(screen.getByLabelText("Upload files"), {
        target: {
          files: [
            new File(["synthetic pdf"], "reference.pdf", {
              type: "application/pdf",
            }),
          ],
        },
      });
      invokeMock.attachmentPrepareError = new Error(
        "The PDF could not be read.",
      );
      fireEvent.submit(textarea.closest("form")!);

      expect(
        await screen.findByText("The PDF could not be read."),
      ).toBeInTheDocument();
      expect(textarea).toHaveValue("Read this reference.");
      expect(screen.getByText("reference.pdf")).toBeInTheDocument();
      expect(
        tauriInvokeMock.mock.calls.some(
          ([command]) => command === "agent_chat_create",
        ),
      ).toBe(false);
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
    }
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

  it("disables sending for an unreadable profile and refreshes after focus", async () => {
    invokeMock.agentConfig = {
      ...invokeMock.agentConfig,
      hasApiKey: true,
      managedProfile: {
        available: false,
        model: "focus-gateway",
        name: "focus",
        port: 8651,
      },
    };
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

    expect(
      await screen.findByPlaceholderText("Connect Hermes in settings"),
    ).toBeDisabled();

    invokeMock.agentConfig = {
      ...invokeMock.agentConfig,
      managedProfile: {
        ...invokeMock.agentConfig.managedProfile!,
        available: true,
      },
    };
    fireEvent(window, new Event("focus"));

    expect(
      await screen.findByPlaceholderText("How can I help you today?"),
    ).toBeEnabled();
  });

  it("preserves an unsent draft when the Hermes preflight fails", async () => {
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
    fireEvent.change(textarea, { target: { value: "Keep this draft." } });
    invokeMock.agentConfigError = new Error("Hermes preflight unavailable");
    fireEvent.submit(textarea.closest("form")!);

    expect(
      await screen.findByText("Hermes preflight unavailable"),
    ).toBeInTheDocument();
    expect(textarea).toHaveValue("Keep this draft.");
    expect(chatMock.sendMessage).not.toHaveBeenCalled();
  });

  it("preserves an unsent draft when chat creation fails", async () => {
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
    fireEvent.change(textarea, { target: { value: "Keep this new chat." } });
    fireEvent.submit(textarea.closest("form")!);

    expect(
      await screen.findByText("Woodshed did not create the Agent chat."),
    ).toBeInTheDocument();
    expect(textarea).toHaveValue("Keep this new chat.");
  });

  it("allows only one Hermes preflight for repeated submits", async () => {
    let resolveConfig: (value: unknown) => void = () => {};
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
    fireEvent.change(textarea, { target: { value: "Send this once." } });
    invokeMock.agentConfigPromise = new Promise((resolve) => {
      resolveConfig = resolve;
    });
    const form = textarea.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => {
      expect(
        tauriInvokeMock.mock.calls.filter(
          ([command]) => command === "agent_config_get",
        ),
      ).toHaveLength(2);
    });

    resolveConfig(invokeMock.agentConfig);
  });

  it("preserves the resolved gateway model in checkpoint updates", () => {
    expect(modelForAgentChatUpdate({ model: "resolved-gateway" })).toBe(
      "resolved-gateway",
    );
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

describe("Agent header run status", () => {
  it("keeps the durable run status in the same topbar as the agent name", () => {
    render(
      <AgentHeader
        configResolved
        configured
        context={null}
        displayName="Hermes"
        run={syntheticRun()}
        status="submitted"
      />,
    );

    const topbar = screen.getByRole("banner");
    expect(topbar).toContainElement(screen.getByText("Hermes"));
    expect(topbar).toContainElement(
      screen.getByText("Running in the background"),
    );
  });

  it("shows a transport interruption without calling the durable run failed", () => {
    render(
      <AgentHeader
        configResolved
        configured
        context={null}
        displayName="Hermes"
        run={syntheticRun()}
        status="submitted"
        transportConnection={{
          status: "disconnected",
          error: "Agent backend unavailable",
        }}
      />,
    );

    expect(screen.getByText("Connection interrupted")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });
});

describe("AgentMessage activity state", () => {
  it("separates the final response with the configured agent name", () => {
    render(
      <AgentMessage
        displayName="Hermes"
        isFirst
        isLastMessage
        isStreaming={false}
        message={{
          id: "assistant-complete",
          role: "assistant",
          parts: [{ type: "text", text: "A concise synthetic answer." }],
        }}
        onToolApprovalResponse={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Hermes", { selector: "span" }),
    ).toBeInTheDocument();
    expect(screen.getByText("A concise synthetic answer.")).toBeInTheDocument();
  });

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
    expect(
      screen.queryByText("Sent context to Hermes"),
    ).not.toBeInTheDocument();
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

      expect(
        screen.queryByText("Sent context to Hermes"),
      ).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(3_999));
      expect(
        screen.queryByText("Sent context to Hermes"),
      ).not.toBeInTheDocument();
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

  it("keeps completed tool work expanded so it is not hidden at completion", () => {
    render(
      <AgentMessage
        displayName="Hermes"
        isFirst
        isLastMessage
        isStreaming={false}
        message={{
          id: "assistant-complete",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "web_search",
              toolCallId: "call_weather",
              state: "output-available",
              input: {},
              output: null,
              title: "Search the synthetic forecast",
            },
            { type: "text", text: "The synthetic forecast is mild." },
          ],
        }}
        onToolApprovalResponse={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "1 step" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Search the synthetic forecast")).toBeVisible();
  });

  it("keeps streamed reasoning collapsed until the user opens it", () => {
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

    expect(
      screen.getByText("Thinking through the response"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Reasoned through it")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Checking the supplied context before answering."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Thinking through the response"));
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
    expect(
      screen.queryByText("Thinking through the response"),
    ).not.toBeInTheDocument();
  });
});

describe("rich Agent responses", () => {
  it("extracts a typed forecast card from a natural-language multi-day response", () => {
    const preview = weatherPreviewFromResponse(
      "A mild week is ahead (from the National Weather Service):\n\n" +
        "Wednesday: mostly sunny, high near 72, low around 56 " +
        "Thursday: fog then sun, high near 70, low around 55 " +
        "Friday: sunny, high near 74, low around 57 (warmest day)\n\n" +
        "Evenings will stay cool.",
    );

    expect(preview).toEqual({
      intro:
        "A mild week is ahead (from the National Weather Service):",
      source: "National Weather Service",
      days: [
        {
          day: "Wednesday",
          condition: "Mostly sunny",
          high: "72",
          low: "56",
          note: null,
        },
        {
          day: "Thursday",
          condition: "Fog then sun",
          high: "70",
          low: "55",
          note: null,
        },
        {
          day: "Friday",
          condition: "Sunny",
          high: "74",
          low: "57",
          note: "warmest day",
        },
      ],
      followUp: "Evenings will stay cool.",
    });
  });

  it("falls back to the complete response when the forecast shape is incomplete", () => {
    expect(
      weatherPreviewFromResponse(
        "Wednesday may be mild, but the source did not provide highs or lows.",
      ),
    ).toBeNull();
    expect(
      weatherPreviewFromResponse(
        "Wednesday: sunny, high near 72, low around 56",
      ),
    ).toBeNull();
  });

  it("renders forecast data as a structured card instead of a dense paragraph", () => {
    render(
      <AgentMessage
        displayName="Hermes"
        isFirst
        isLastMessage
        isStreaming={false}
        message={{
          id: "assistant-weather",
          role: "assistant",
          parts: [
            {
              type: "text",
              text:
                "A mild week is ahead:\n\n" +
                "Wednesday: mostly sunny, high near 72°F, low around 56°F, " +
                "with gusty winds after sunset " +
                "Thursday: fog then sun, high near 70°F, low around 55°F\n\n" +
                "Evenings will stay cool.",
            },
          ],
        }}
        onToolApprovalResponse={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Weather forecast" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Wednesday")).toBeInTheDocument();
    expect(screen.getByLabelText("High 72 degrees")).toBeInTheDocument();
    expect(screen.getByLabelText("Low 56 degrees")).toBeInTheDocument();
    expect(screen.getByText("View original response")).toBeInTheDocument();
    expect(
      screen.getByText(/with gusty winds after sunset/),
    ).toBeInTheDocument();
    expect(screen.getByText(/72°F/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /1 background run/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open Background research" }),
    );
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
    expect(
      screen.getByRole("button", { name: "1.5K tokens used" }),
    ).toBeInTheDocument();

    rerender(<AgentContextUsage run={syntheticRun()} />);
    expect(
      screen.queryByRole("button", { name: /tokens used/ }),
    ).not.toBeInTheDocument();
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
    expect(
      screen.getByText("The local agent was unavailable."),
    ).toBeInTheDocument();
  });

  it("asks for reattachment instead of offering a broken retry", () => {
    const failedRun: AgentRun = {
      ...syntheticRun(),
      status: "failed",
      finishedAt: "2031-02-03T12:00:02Z",
      finalResponse: null,
      error: "The local agent was unavailable.",
    };

    render(<AgentRunBanner retryNeedsReattachment run={failedRun} />);

    expect(screen.getByText("Reattach files to retry")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });
});

describe("persisted agent attachments", () => {
  it("rehydrates historical activity without replacing a live reconnect", () => {
    const liveMessage: UIMessage = {
      id: "agent-response-live",
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          text: "Checking a current synthetic request.",
          state: "streaming",
        },
        { type: "text", text: "A partial response", state: "streaming" },
      ],
    };
    const messages = mergeHydratedConversationMessages(
      [
        {
          id: "agent-response-synthetic",
          role: "assistant",
          createdAt: "2031-02-03T12:00:02Z",
          content: "The historical response is complete.",
          agentRunId: "agent-run-synthetic",
        },
      ],
      [
        {
          id: "agent-response-synthetic",
          role: "assistant",
          parts: [{ type: "text", text: "The historical response is complete." }],
        },
        liveMessage,
      ],
      {
        hydratedChatId: "agent-conversation-1",
        loadedChatId: "agent-conversation-1",
      },
      [
        syntheticRun({
          status: "completed",
          events: [
            { kind: "reasoning-delta", delta: "Checked the synthetic source." },
            {
              kind: "tool-input-available",
              toolCallId: "call_reference",
              toolName: "search_reference",
              input: { query: "synthetic" },
              title: "Search the reference",
              dynamic: true,
            },
          ],
          finalResponse: "The historical response is complete.",
          finishedAt: "2031-02-03T12:00:02Z",
        }),
      ],
    );

    expect(messages[0]?.parts).toEqual([
      {
        type: "reasoning",
        text: "Checked the synthetic source.",
        state: "done",
      },
      {
        type: "dynamic-tool",
        toolName: "search_reference",
        toolCallId: "call_reference",
        state: "input-available",
        input: { query: "synthetic" },
        title: "Search the reference",
      },
      { type: "text", text: "The historical response is complete." },
    ]);
    expect(messages[1]).toBe(liveMessage);
  });

  it("restores completed Hermes activity from the durable run", () => {
    const [message] = toUiMessages(
      [
        {
          id: "agent-response-synthetic",
          role: "assistant",
          createdAt: "2031-02-03T12:00:02Z",
          content: "The synthetic forecast is sunny.",
          agentRunId: "agent-run-synthetic",
        },
      ],
      [],
      undefined,
      [
        syntheticRun({
          assistantMessageId: "agent-response-synthetic",
          status: "completed",
          events: [
            { kind: "reasoning-delta", delta: "Checked the forecast source." },
            {
              kind: "tool-input-available",
              toolCallId: "call_weather",
              toolName: "web_search",
              input: {},
              title: "Search the weekly forecast",
              dynamic: true,
            },
            {
              kind: "tool-output-available",
              toolCallId: "call_weather",
              output: null,
              dynamic: true,
            },
            { kind: "delta", delta: "The synthetic forecast is sunny." },
          ],
          finalResponse: "The synthetic forecast is sunny.",
          finishedAt: "2031-02-03T12:00:02Z",
        }),
      ],
    );

    expect(message.parts).toEqual([
      {
        type: "reasoning",
        text: "Checked the forecast source.",
        state: "done",
      },
      {
        type: "dynamic-tool",
        toolName: "web_search",
        toolCallId: "call_weather",
        state: "output-available",
        input: {},
        output: null,
        title: "Search the weekly forecast",
      },
      { type: "text", text: "The synthetic forecast is sunny." },
    ]);
  });

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

    render(
      <AgentThoughtTool onToolApprovalResponse={onApproval} part={part} />,
    );

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

    render(
      <AgentThoughtTool onToolApprovalResponse={onApproval} part={part} />,
    );

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

describe("conversationAutoTitle", () => {
  const userMessage = (content: string) => ({
    id: `m_${content.length}`,
    role: "user" as const,
    content,
    createdAt: "2026-08-06T20:00:00.000Z",
    agentRunId: null,
  });

  it("uses the first substantive user message, skipping trivial openers", () => {
    expect(
      conversationAutoTitle([
        userMessage("good evening"),
        userMessage("can we leverage gbrain for woodshed?"),
      ]),
    ).toBe("can we leverage gbrain for woodshed?");
    // Punctuation variants of a greeting are skipped too.
    expect(
      conversationAutoTitle([userMessage("good evening!"), userMessage("what's on the roadmap?")]),
    ).toBe("what's on the roadmap?");
  });

  it("falls back to the first user message when everything is trivial", () => {
    expect(conversationAutoTitle([userMessage("hi")])).toBe("hi");
  });

  it("truncates long titles like the create-time fallback", () => {
    const long = "a".repeat(120);
    const title = conversationAutoTitle([userMessage(long)]);
    expect(title).toBe(`${"a".repeat(55)}...`);
    expect(title?.length).toBe(58);
  });

  it("returns null without user messages", () => {
    expect(
      conversationAutoTitle([
        {
          id: "a1",
          role: "assistant",
          content: "hi there",
          createdAt: "2026-08-06T20:00:00.000Z",
          agentRunId: null,
        },
      ]),
    ).toBeNull();
    expect(conversationAutoTitle([])).toBeNull();
  });
});

describe("isAutoDerivedTitle", () => {
  const messages = [
    {
      id: "m1",
      role: "user" as const,
      content: "can we leverage gbrain for woodshed?",
      createdAt: "2026-08-06T20:00:00.000Z",
      agentRunId: null,
    },
  ];

  it("treats the placeholder, empty, and first-message titles as auto", () => {
    expect(isAutoDerivedTitle("New chat", messages)).toBe(true);
    expect(isAutoDerivedTitle("", messages)).toBe(true);
    expect(
      isAutoDerivedTitle("can we leverage gbrain for woodshed?", messages),
    ).toBe(true);
  });

  it("never treats a manual rename as auto-derived", () => {
    expect(isAutoDerivedTitle("Woodshed architecture notes", messages)).toBe(
      false,
    );
    // Attachment-derived titles (≠ first-message text) are preserved too.
    expect(isAutoDerivedTitle("Screenshot-2026-08-06.png", messages)).toBe(
      false,
    );
  });
});

describe("isScrollContainerPinned", () => {
  const el = (scrollTop: number, scrollHeight = 1000, clientHeight = 800) => ({
    scrollTop,
    scrollHeight,
    clientHeight,
  });

  it("treats a truly pinned container as pinned", () => {
    expect(isScrollContainerPinned(el(200))).toBe(true); // exactly at bottom
    expect(isScrollContainerPinned(el(197))).toBe(true); // 3px above
  });

  it("is never pinned for an unmeasured container", () => {
    expect(isScrollContainerPinned(null)).toBe(false);
  });

  it("jumps for any real scroll-up, including the library's 70px near-bottom band", () => {
    // The stick-to-bottom context reports isAtBottom for up to 70px above
    // the bottom; the guard must NOT reuse that fuzzy signal or a user
    // scrolled up 1–70px would miss new messages. Only the tight 4px
    // tolerance counts as pinned.
    expect(isScrollContainerPinned(el(130))).toBe(false); // 70px above
    expect(isScrollContainerPinned(el(150))).toBe(false); // 50px above
    expect(isScrollContainerPinned(el(190))).toBe(false); // 10px above
    expect(isScrollContainerPinned(el(197))).toBe(true); // 3px above → pinned
  });
});
