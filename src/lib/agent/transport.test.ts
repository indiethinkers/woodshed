import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  tauriInvoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: mocks.tauriInvoke,
}));

import { createAgentChatTransport } from "./transport";

describe("createAgentChatTransport", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prepends fresh page context as a system message", async () => {
    mocks.listen.mockResolvedValue(() => {});
    mocks.tauriInvoke.mockResolvedValue(null);
    const transport = createAgentChatTransport({
      getSystemContext: () => "Current page: Alex Rivera",
    });
    const messages: UIMessage[] = [
      {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "What should I know?" }],
      },
    ];

    await transport.sendMessages({
      abortSignal: undefined,
      chatId: "chat-1",
      messages,
      trigger: "submit-message",
      messageId: "message-1",
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(mocks.tauriInvoke).toHaveBeenCalledWith("agent_chat_stream", {
      input: {
        streamId: expect.any(String),
        conversationId: "chat-1",
        messages: [
          { role: "system", content: "Current page: Alex Rivera" },
          { role: "user", content: "What should I know?" },
        ],
      },
    });
    expect(mocks.tauriInvoke.mock.calls[0]?.[1]?.input.messages).toEqual([
      { role: "system", content: "Current page: Alex Rivera" },
      { role: "user", content: "What should I know?" },
    ]);
  });
});
