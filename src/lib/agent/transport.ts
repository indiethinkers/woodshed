import type { ChatTransport, FileUIPart, UIMessage, UIMessageChunk } from "ai";
import { nanoid } from "nanoid";
import { attachmentContextFromFiles } from "@/lib/agent/attachment-context";
import { tauriInvoke } from "@/lib/tauri";

interface AgentChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface PreparedAgentAttachment {
  context: string;
}

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

interface AgentRunInputMessage {
  id: string;
  role: "user";
  createdAt: string;
  content: string;
}

export interface AgentRun {
  id: string;
  conversationId: string;
  sessionId: string;
  assistantMessageId: string;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  inputMessage: AgentRunInputMessage;
  events: AgentRunEvent[];
  finalResponse?: string | null;
  error?: string | null;
  retryOf?: string | null;
}

export interface AgentTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface AgentRunEvent {
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
    | "usage"
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
  usage?: AgentTokenUsage | null;
}

interface StreamPartIds {
  messageId: string;
  textId: string;
  reasoningId: string;
  reasoningStarted: boolean;
}

interface AgentTransportOptions {
  getSystemContext?: () => string | null;
  onRunChange?: (run: AgentRun | null) => void;
  pollIntervalMs?: number;
}

export function createAgentChatTransport(
  options: AgentTransportOptions = {},
): ChatTransport<UIMessage> {
  return {
    async sendMessages({ chatId, messages, trigger, messageId, abortSignal }) {
      const systemContext = options.getSystemContext?.()?.trim();
      const inputMessage = latestUserMessage(messages);
      if (!inputMessage) {
        throw new Error("Agent requests need a user message.");
      }
      const agentMessages = await messagesToAgentMessages(
        messages,
        inputMessage.id,
      );
      if (systemContext) {
        agentMessages.unshift({ role: "system", content: systemContext });
      }

      let retryOf: string | undefined;
      let idempotencyKey = inputMessage.id;
      if (trigger === "regenerate-message") {
        const recent = await listRuns(chatId);
        retryOf = recent.find(
          (run) =>
            run.assistantMessageId === messageId ||
            run.inputMessage.id === messageId ||
            run.inputMessage.id === inputMessage.id,
        )?.id;
        idempotencyKey = `agent-retry-${nanoid()}`;
      }

      const run = await tauriInvoke<AgentRun>("agent_run_create", {
        input: {
          conversationId: chatId,
          idempotencyKey,
          inputMessage,
          messages: agentMessages,
          retryOf,
        },
      });
      if (!run) throw new Error("Woodshed did not create an agent run.");
      options.onRunChange?.(run);
      return streamAgentRun(run, abortSignal, options);
    },
    async reconnectToStream({ chatId }) {
      const runs = await listRuns(chatId);
      const active = runs.find(
        (run) => run.status === "queued" || run.status === "running",
      );
      if (!active) {
        // Keep the latest terminal run visible after reload as well. There is
        // no stream to resume, but failed/cancelled states still need useful UI.
        options.onRunChange?.(runs[0] ?? null);
        return null;
      }
      options.onRunChange?.(active);
      return streamAgentRun(active, undefined, options);
    },
  };
}

export async function listActiveAgentRuns(): Promise<AgentRun[]> {
  return (await tauriInvoke<AgentRun[]>("agent_runs_active")) ?? [];
}

export async function cancelAgentRun(runId: string): Promise<AgentRun> {
  const run = await tauriInvoke<AgentRun>("agent_run_cancel", { runId });
  if (!run) throw new Error("Woodshed did not cancel the agent run.");
  return run;
}

function streamAgentRun(
  initialRun: AgentRun,
  abortSignal: AbortSignal | undefined,
  options: AgentTransportOptions,
): ReadableStream<UIMessageChunk> {
  let stopped = false;
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const ids = startMessage(controller, initialRun.assistantMessageId);
      let eventIndex = 0;
      let emittedText = "";
      let pollFailures = 0;

      const close = () => {
        if (stopped) return;
        stopped = true;
        abortSignal?.removeEventListener("abort", abort);
        controller.close();
      };
      const fail = (message: string) => {
        enqueue(controller, { type: "error", errorText: message });
        close();
      };
      const abort = () => {
        enqueue(controller, { type: "abort", reason: "detached" });
        close();
      };
      const accept = (run: AgentRun): boolean => {
        options.onRunChange?.(run);
        for (const event of coalesceAgentEvents(run.events.slice(eventIndex))) {
          enqueueAgentEvent(controller, ids, event);
          if (event.kind === "delta" && event.delta) emittedText += event.delta;
        }
        eventIndex = run.events.length;

        if (run.status === "completed") {
          const finalResponse = run.finalResponse ?? "";
          if (finalResponse.startsWith(emittedText)) {
            const remainder = finalResponse.slice(emittedText.length);
            if (remainder) {
              enqueue(controller, {
                type: "text-delta",
                id: ids.textId,
                delta: remainder,
              });
            }
          }
          finishMessage(controller, ids);
          close();
          return true;
        }
        if (run.status === "failed") {
          fail(run.error || "Agent run failed.");
          return true;
        }
        if (run.status === "cancelled") {
          enqueue(controller, { type: "abort", reason: "cancelled" });
          close();
          return true;
        }
        return false;
      };

      if (abortSignal?.aborted) {
        abort();
        return;
      }
      abortSignal?.addEventListener("abort", abort, { once: true });
      if (accept(initialRun)) return;

      while (!stopped) {
        await delay(options.pollIntervalMs ?? 100);
        if (stopped) return;
        try {
          const run = await tauriInvoke<AgentRun | null>("agent_run_get", {
            runId: initialRun.id,
          });
          if (!run) {
            fail("Agent run could not be found.");
            return;
          }
          pollFailures = 0;
          if (accept(run)) return;
        } catch (error) {
          pollFailures += 1;
          if (pollFailures >= 3) {
            fail(error instanceof Error ? error.message : String(error));
            return;
          }
        }
      }
    },
    cancel() {
      // Stream cancellation only detaches this page. Explicit user cancellation
      // calls agent_run_cancel; navigation/reload must leave the backend job alive.
      stopped = true;
    },
  });
}

/**
 * A durable run records model output at provider-token granularity. Polling can
 * therefore discover hundreds of adjacent deltas at once. Replaying every one
 * through the AI SDK forces React to rebuild and reparse the growing message
 * hundreds of times in one task. Merge only adjacent, semantically equivalent
 * deltas so tool/reasoning boundaries and their ordering remain intact while
 * each poll produces a bounded number of UI updates.
 */
function coalesceAgentEvents(events: AgentRunEvent[]): AgentRunEvent[] {
  const coalesced: AgentRunEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (event.kind === "delta" && event.delta) {
      if (previous?.kind === "delta") {
        previous.delta = `${previous.delta ?? ""}${event.delta}`;
      } else {
        coalesced.push({ ...event });
      }
      continue;
    }
    if (event.kind === "reasoning-delta" && event.delta) {
      if (previous?.kind === "reasoning-delta") {
        previous.delta = `${previous.delta ?? ""}${event.delta}`;
      } else {
        coalesced.push({ ...event });
      }
      continue;
    }
    if (event.kind === "tool-input-delta" && event.inputTextDelta) {
      if (
        previous?.kind === "tool-input-delta" &&
        previous.toolCallId === event.toolCallId
      ) {
        previous.inputTextDelta = `${previous.inputTextDelta ?? ""}${event.inputTextDelta}`;
      } else {
        coalesced.push({ ...event });
      }
      continue;
    }
    coalesced.push(event);
  }
  return coalesced;
}

async function listRuns(chatId: string): Promise<AgentRun[]> {
  return (
    (await tauriInvoke<AgentRun[]>("agent_runs_for_conversation", {
      conversationId: chatId,
    })) ?? []
  );
}

export function latestAgentUsage(run: AgentRun | null): AgentTokenUsage | null {
  if (!run) return null;
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const usage = run.events[index].usage;
    if (usage) return usage;
  }
  return null;
}

function latestUserMessage(messages: UIMessage[]): AgentRunInputMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const content = messageContentForTranscript(message).trim();
    if (!content) continue;
    return {
      id: message.id,
      role: "user",
      createdAt: new Date().toISOString(),
      content,
    };
  }
  return null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function startMessage(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  messageId: string,
) {
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
  endReasoning(controller, ids);
  enqueue(controller, { type: "text-end", id: ids.textId });
  enqueue(controller, { type: "finish-step" });
  enqueue(controller, { type: "finish", finishReason: "stop" });
}

function enqueueAgentEvent(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  ids: StreamPartIds,
  payload: AgentRunEvent,
) {
  if (payload.kind !== "reasoning-delta") {
    endReasoning(controller, ids);
  }
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
  if (payload.kind === "tool-output-denied" && payload.toolCallId) {
    enqueue(controller, {
      type: "tool-output-denied",
      toolCallId: payload.toolCallId,
    });
  }
}

function endReasoning(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  ids: StreamPartIds,
) {
  if (!ids.reasoningStarted) return;
  enqueue(controller, { type: "reasoning-end", id: ids.reasoningId });
  ids.reasoningStarted = false;
  ids.reasoningId = nanoid();
}

function enqueue(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  chunk: UIMessageChunk,
) {
  try {
    controller.enqueue(chunk);
  } catch {
    // The AI SDK may close the stream after a local detach. The backend job
    // remains authoritative, so late poll results are intentionally ignored.
  }
}

async function messagesToAgentMessages(
  messages: UIMessage[],
  submittedMessageId: string,
): Promise<AgentChatMessage[]> {
  const prepared = await Promise.all(
    messages.map(async (message) => ({
      role: message.role,
      content: (
        await messageContentForHermes(
          message,
          message.id === submittedMessageId ? "submitted" : "history",
        )
      ).trim(),
    })),
  );
  return prepared.filter((message): message is AgentChatMessage => {
    return (
      (message.role === "system" ||
        message.role === "user" ||
        message.role === "assistant") &&
      message.content.length > 0
    );
  });
}

function messageTextAndFiles(message: UIMessage): {
  files: FileUIPart[];
  text: string;
} {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  const files = message.parts.filter(isFilePart);
  return { files, text };
}

function messageContentForTranscript(message: UIMessage): string {
  const { files, text } = messageTextAndFiles(message);
  return [text, attachmentContextFromFiles(files)].filter(Boolean).join("\n\n");
}

async function messageContentForHermes(
  message: UIMessage,
  attachmentPolicy: "submitted" | "history",
): Promise<string> {
  const { files, text } = messageTextAndFiles(message);
  const loadedFiles = files.filter((file) => Boolean(file.url));
  const unloadedFiles = files.filter((file) => !file.url);
  if (attachmentPolicy === "submitted" && unloadedFiles.length > 0) {
    throw new Error(
      "An attachment is no longer loaded. Reattach it before sending.",
    );
  }
  const preparedContext = await prepareAttachmentContext(loadedFiles);
  return [text, preparedContext].filter(Boolean).join("\n\n");
}

async function prepareAttachmentContext(files: FileUIPart[]): Promise<string> {
  if (files.length === 0) return "";
  const contexts = await Promise.all(
    files.map(async (file) => {
      if (!file.url) {
        throw new Error(
          "An attachment is no longer loaded. Reattach it before sending.",
        );
      }
      const prepared = await tauriInvoke<PreparedAgentAttachment>(
        "agent_attachment_prepare",
        {
          input: {
            filename: file.filename,
            mediaType: file.mediaType,
            dataUrl: file.url,
          },
        },
      );
      if (!prepared?.context) {
        throw new Error("Woodshed could not prepare the attachment.");
      }
      return prepared.context;
    }),
  );
  return contexts.join("\n\n");
}

function isFilePart(
  part: UIMessage["parts"][number],
): part is UIMessage["parts"][number] & FileUIPart {
  return part.type === "file";
}
