import type { UIMessage, UIMessageChunk } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tauriInvoke: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: mocks.tauriInvoke,
}));

import { type AgentRun, createAgentChatTransport } from "./transport";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "agent-run-1",
    conversationId: "chat-1",
    sessionId: "chat-1",
    assistantMessageId: "agent-response-1",
    status: "completed",
    createdAt: "2031-02-03T12:00:00Z",
    updatedAt: "2031-02-03T12:00:02Z",
    startedAt: "2031-02-03T12:00:01Z",
    finishedAt: "2031-02-03T12:00:02Z",
    inputMessage: {
      id: "message-1",
      role: "user",
      createdAt: "2031-02-03T12:00:00Z",
      content: "What should I know?",
    },
    events: [{ kind: "delta", delta: "A durable answer." }],
    finalResponse: "A durable answer.",
    error: null,
    retryOf: null,
    ...overrides,
  };
}

async function readChunks(
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) return chunks;
    chunks.push(result.value);
  }
}

describe("createAgentChatTransport", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("creates a durable run with a stable user-message idempotency key", async () => {
    mocks.tauriInvoke.mockResolvedValueOnce(run());
    const onRunChange = vi.fn();
    const transport = createAgentChatTransport({
      getSystemContext: () => "Current page: Example record",
      onRunChange,
      pollIntervalMs: 0,
    });
    const messages: UIMessage[] = [
      {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "What should I know?" }],
      },
    ];

    const stream = await transport.sendMessages({
      abortSignal: undefined,
      chatId: "chat-1",
      messages,
      trigger: "submit-message",
      messageId: "message-1",
    });
    const chunks = await readChunks(stream);

    expect(mocks.tauriInvoke).toHaveBeenCalledWith("agent_run_create", {
      input: {
        conversationId: "chat-1",
        idempotencyKey: "message-1",
        inputMessage: {
          id: "message-1",
          role: "user",
          createdAt: expect.any(String),
          content: "What should I know?",
        },
        messages: [
          { role: "system", content: "Current page: Example record" },
          { role: "user", content: "What should I know?" },
        ],
        retryOf: undefined,
      },
    });
    expect(onRunChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-run-1", status: "completed" }),
    );
    expect(chunks).toContainEqual({
      type: "start",
      messageId: "agent-response-1",
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "text-delta", delta: "A durable answer." }),
    );
  });

  it("prepares PDF contents before sending an attachment to the agent", async () => {
    mocks.tauriInvoke
      .mockResolvedValueOnce({
        context:
          "[Attachment: review.pdf (application/pdf)]\nSynthetic review text.\n[/Attachment]",
      })
      .mockResolvedValueOnce(run());
    const transport = createAgentChatTransport({ pollIntervalMs: 0 });

    const stream = await transport.sendMessages({
      abortSignal: undefined,
      chatId: "chat-1",
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [
            { type: "text", text: "Summarize this review." },
            {
              type: "file",
              filename: "review.pdf",
              mediaType: "application/pdf",
              url: "data:application/pdf;base64,JVBERi0xLjQK",
            },
          ],
        },
      ],
      trigger: "submit-message",
      messageId: "message-1",
    });
    await readChunks(stream);

    expect(mocks.tauriInvoke).toHaveBeenNthCalledWith(
      1,
      "agent_attachment_prepare",
      {
        input: {
          filename: "review.pdf",
          mediaType: "application/pdf",
          dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
        },
      },
    );
    expect(mocks.tauriInvoke).toHaveBeenNthCalledWith(
      2,
      "agent_run_create",
      {
        input: expect.objectContaining({
          inputMessage: expect.objectContaining({
            content:
              "Summarize this review.\n\nAttachments:\n- review.pdf (application/pdf)",
          }),
          messages: [
            {
              role: "user",
              content:
                "Summarize this review.\n\n[Attachment: review.pdf (application/pdf)]\nSynthetic review text.\n[/Attachment]",
            },
          ],
        }),
      },
    );
  });

  it("rejects an unloaded attachment instead of sending a filename hint", async () => {
    const transport = createAgentChatTransport({ pollIntervalMs: 0 });

    await expect(
      transport.sendMessages({
        abortSignal: undefined,
        chatId: "chat-1",
        messages: [
          {
            id: "message-1",
            role: "user",
            parts: [
              { type: "text", text: "Read this attachment." },
              {
                type: "file",
                filename: "notes.pdf",
                mediaType: "application/pdf",
                url: "",
              },
            ],
          },
        ],
        trigger: "submit-message",
        messageId: "message-1",
      }),
    ).rejects.toThrow("no longer loaded");
    expect(mocks.tauriInvoke).not.toHaveBeenCalled();
  });

  it("reconnects to an existing active run and polls it to completion", async () => {
    mocks.tauriInvoke
      .mockResolvedValueOnce([
        run({ status: "running", events: [], finalResponse: null }),
      ])
      .mockResolvedValueOnce(run());
    const onRunChange = vi.fn();
    const transport = createAgentChatTransport({ onRunChange, pollIntervalMs: 0 });

    const stream = await transport.reconnectToStream({ chatId: "chat-1" });
    expect(stream).not.toBeNull();
    const chunks = await readChunks(stream!);

    expect(mocks.tauriInvoke).toHaveBeenNthCalledWith(
      1,
      "agent_runs_for_conversation",
      { conversationId: "chat-1" },
    );
    expect(mocks.tauriInvoke).toHaveBeenNthCalledWith(2, "agent_run_get", {
      runId: "agent-run-1",
    });
    expect(onRunChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "finish", finishReason: "stop" }),
    );
  });

  it("surfaces a durable failed status and its stored error", async () => {
    mocks.tauriInvoke.mockResolvedValueOnce(
      run({
        status: "failed",
        events: [],
        finalResponse: null,
        error: "The local agent was unavailable.",
      }),
    );
    const transport = createAgentChatTransport();

    const stream = await transport.sendMessages({
      abortSignal: undefined,
      chatId: "chat-1",
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "What should I know?" }],
        },
      ],
      trigger: "submit-message",
      messageId: "message-1",
    });
    const chunks = await readChunks(stream);

    expect(chunks).toContainEqual({
      type: "error",
      errorText: "The local agent was unavailable.",
    });
  });

  it("restores the latest failed state even when there is no stream to resume", async () => {
    const failed = run({
      status: "failed",
      events: [],
      finalResponse: null,
      error: "Woodshed restarted before this run finished.",
    });
    mocks.tauriInvoke.mockResolvedValueOnce([failed]);
    const onRunChange = vi.fn();
    const transport = createAgentChatTransport({ onRunChange });

    const stream = await transport.reconnectToStream({ chatId: "chat-1" });

    expect(stream).toBeNull();
    expect(onRunChange).toHaveBeenCalledWith(failed);
  });

  it("creates an explicitly linked run when the user retries a failed turn", async () => {
    const failed = run({
      id: "agent-run-failed",
      status: "failed",
      events: [],
      finalResponse: null,
      error: "The local agent was unavailable.",
    });
    mocks.tauriInvoke
      .mockResolvedValueOnce([failed])
      .mockResolvedValueOnce(run({ retryOf: failed.id }));
    const transport = createAgentChatTransport();

    const stream = await transport.sendMessages({
      abortSignal: undefined,
      chatId: "chat-1",
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "What should I know?" }],
        },
      ],
      trigger: "regenerate-message",
      messageId: undefined,
    });
    await readChunks(stream);

    expect(mocks.tauriInvoke).toHaveBeenNthCalledWith(
      2,
      "agent_run_create",
      {
        input: expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^agent-retry-/),
          retryOf: "agent-run-failed",
        }),
      },
    );
  });
});
