import type { ChatTransport, FileUIPart, UIMessage, UIMessageChunk } from "ai";
import { nanoid } from "nanoid";
import { attachmentContextFromFiles } from "@/lib/agent/attachment-context";
import { tauriInvoke } from "@/lib/tauri";

interface AgentChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AgentChatStreamEvent {
  streamId: string;
  kind:
    | "delta"
    | "reasoning-delta"
    | "tool-input-start"
    | "tool-input-delta"
    | "tool-input-available"
    | "tool-input-error"
    | "tool-output-available"
    | "tool-output-error"
    | "tool-output-denied"
    | "done"
    | "error";
  delta?: string | null;
  error?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  inputTextDelta?: string | null;
  input?: unknown;
  output?: unknown;
  errorText?: string | null;
  title?: string | null;
  dynamic?: boolean | null;
}

interface StreamPartIds {
  messageId: string;
  textId: string;
  reasoningId: string;
  reasoningStarted: boolean;
}

export function createAgentChatTransport(options?: {
  getSystemContext?: () => string | null;
}): ChatTransport<UIMessage> {
  return {
    async sendMessages({ chatId, messages, abortSignal }) {
      const systemContext = options?.getSystemContext?.()?.trim();
      const agentMessages = messagesToAgentMessages(messages);
      if (systemContext) {
        agentMessages.unshift({ role: "system", content: systemContext });
      }
      return sendViaTauriEvents(chatId, agentMessages, abortSignal);
    },
    async reconnectToStream() {
      return null;
    },
  };
}

function sendViaTauriEvents(
  chatId: string,
  messages: AgentChatMessage[],
  abortSignal?: AbortSignal,
): Promise<ReadableStream<UIMessageChunk>> {
  return Promise.resolve(
    new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const streamId = nanoid();
        const ids = startMessage(controller);
        let closed = false;
        let unlisten: (() => void) | null = null;

        const close = () => {
          if (closed) return;
          closed = true;
          unlisten?.();
          controller.close();
        };
        const fail = (message: string) => {
          enqueue(controller, { type: "error", errorText: message });
          close();
        };
        const abort = () => {
          enqueue(controller, { type: "abort", reason: "aborted" });
          close();
        };

        if (abortSignal?.aborted) {
          abort();
          return;
        }

        abortSignal?.addEventListener("abort", abort, { once: true });

        try {
          const { listen } = await import("@tauri-apps/api/event");
          unlisten = await listen<AgentChatStreamEvent>(
            "agent:chat-stream",
            (event) => {
              const payload = event.payload;
              if (!payload || payload.streamId !== streamId || closed) return;
              if (payload.kind === "done") {
                finishMessage(controller, ids);
                close();
                return;
              }
              if (payload.kind === "error") {
                fail(payload.error || "Agent stream failed.");
                return;
              }
              enqueueAgentEvent(controller, ids, payload);
            },
          );
          await tauriInvoke("agent_chat_stream", {
            input: { streamId, conversationId: chatId, messages },
          });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      },
    }),
  );
}

function startMessage(controller: ReadableStreamDefaultController<UIMessageChunk>) {
  const messageId = nanoid();
  const textId = nanoid();
  const reasoningId = nanoid();
  enqueue(controller, { type: "start", messageId });
  enqueue(controller, { type: "start-step" });
  enqueue(controller, { type: "text-start", id: textId });
  return { messageId, reasoningId, reasoningStarted: false, textId };
}

function finishMessage(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  ids: StreamPartIds,
) {
  if (ids.reasoningStarted) {
    enqueue(controller, { type: "reasoning-end", id: ids.reasoningId });
  }
  enqueue(controller, { type: "text-end", id: ids.textId });
  enqueue(controller, { type: "finish-step" });
  enqueue(controller, { type: "finish", finishReason: "stop" });
}

function enqueueAgentEvent(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  ids: StreamPartIds,
  payload: AgentChatStreamEvent,
) {
  if (payload.kind === "delta" && payload.delta) {
    enqueue(controller, {
      type: "text-delta",
      id: ids.textId,
      delta: payload.delta,
    });
    return;
  }
  if (payload.kind === "reasoning-delta" && payload.delta) {
    if (!ids.reasoningStarted) {
      enqueue(controller, { type: "reasoning-start", id: ids.reasoningId });
      ids.reasoningStarted = true;
    }
    enqueue(controller, {
      type: "reasoning-delta",
      id: ids.reasoningId,
      delta: payload.delta,
    });
    return;
  }
  if (payload.kind === "tool-input-start") {
    const toolCallId = payload.toolCallId;
    const toolName = payload.toolName;
    if (!toolCallId || !toolName) return;
    enqueue(controller, {
      type: "tool-input-start",
      toolCallId,
      toolName,
      dynamic: payload.dynamic ?? true,
      title: payload.title ?? undefined,
    });
    return;
  }
  if (payload.kind === "tool-input-delta") {
    const toolCallId = payload.toolCallId;
    const inputTextDelta = payload.inputTextDelta;
    if (!toolCallId || !inputTextDelta) return;
    enqueue(controller, {
      type: "tool-input-delta",
      toolCallId,
      inputTextDelta,
    });
    return;
  }
  if (payload.kind === "tool-input-available") {
    const toolCallId = payload.toolCallId;
    const toolName = payload.toolName;
    if (!toolCallId || !toolName) return;
    enqueue(controller, {
      type: "tool-input-available",
      toolCallId,
      toolName,
      input: payload.input ?? {},
      dynamic: payload.dynamic ?? true,
      title: payload.title ?? undefined,
    });
    return;
  }
  if (payload.kind === "tool-input-error") {
    const toolCallId = payload.toolCallId;
    const toolName = payload.toolName;
    if (!toolCallId || !toolName) return;
    enqueue(controller, {
      type: "tool-input-error",
      toolCallId,
      toolName,
      input: payload.input,
      errorText: payload.errorText || "Tool input failed.",
      dynamic: payload.dynamic ?? true,
      title: payload.title ?? undefined,
    });
    return;
  }
  if (payload.kind === "tool-output-available") {
    if (!payload.toolCallId) return;
    enqueue(controller, {
      type: "tool-output-available",
      toolCallId: payload.toolCallId,
      output: payload.output ?? {},
      dynamic: payload.dynamic ?? true,
    });
    return;
  }
  if (payload.kind === "tool-output-error") {
    if (!payload.toolCallId) return;
    enqueue(controller, {
      type: "tool-output-error",
      toolCallId: payload.toolCallId,
      errorText: payload.errorText || "Tool output failed.",
      dynamic: payload.dynamic ?? true,
    });
    return;
  }
  if (payload.kind === "tool-output-denied") {
    if (!payload.toolCallId) return;
    enqueue(controller, {
      type: "tool-output-denied",
      toolCallId: payload.toolCallId,
    });
  }
}

function enqueue(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  chunk: UIMessageChunk,
) {
  try {
    controller.enqueue(chunk);
  } catch {
    // The AI SDK may close the stream after an abort; late Hermes chunks are ignored.
  }
}

function messagesToAgentMessages(messages: UIMessage[]): AgentChatMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: messageContentForAgent(message).trim(),
    }))
    .filter((message): message is AgentChatMessage => {
      return (
        (message.role === "system" ||
          message.role === "user" ||
          message.role === "assistant") &&
        message.content.length > 0
      );
    });
}

function messageContentForAgent(message: UIMessage): string {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  const files = message.parts.filter(isFilePart);
  return [text, attachmentContextFromFiles(files)].filter(Boolean).join("\n\n");
}

function isFilePart(
  part: UIMessage["parts"][number],
): part is UIMessage["parts"][number] & FileUIPart {
  return part.type === "file";
}
