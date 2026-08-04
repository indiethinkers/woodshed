import type {
  ChatTransport,
  DynamicToolUIPart,
  FileUIPart,
  UIMessage,
  UIMessageChunk,
} from "ai";
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
  tools: Map<string, HydratedAgentTool>;
}

interface AgentTransportOptions {
  getSystemContext?: () => string | null;
  onConnectionChange?: (connection: AgentTransportConnection) => void;
  onRunChange?: (run: AgentRun | null) => void;
  pollIntervalMs?: number;
  reconnectTimeoutMs?: number;
}

export interface AgentTransportConnection {
  status: "connected" | "reconnecting" | "disconnected";
  error: string | null;
}

const DEFAULT_AGENT_RECONNECT_TIMEOUT_MS = 30_000;

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
        const recent = await listAgentRunsForConversation(chatId);
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
      const runs = await listAgentRunsForConversation(chatId);
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
      let pollFailureStartedAt: number | null = null;
      let connection: AgentTransportConnection | null = null;

      const reportConnection = (
        status: AgentTransportConnection["status"],
        error: string | null = null,
      ) => {
        if (connection?.status === status && connection.error === error) return;
        connection = { status, error };
        options.onConnectionChange?.(connection);
      };

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
      reportConnection("connected");
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
          pollFailureStartedAt = null;
          reportConnection("connected");
          if (accept(run)) return;
        } catch (error) {
          const now = Date.now();
          pollFailureStartedAt ??= now;
          const reconnectTimeoutMs =
            options.reconnectTimeoutMs ?? DEFAULT_AGENT_RECONNECT_TIMEOUT_MS;
          const message =
            error instanceof Error ? error.message : String(error);
          reportConnection(
            now - pollFailureStartedAt < reconnectTimeoutMs
              ? "reconnecting"
              : "disconnected",
            message,
          );
          // A renderer-side transport failure cannot authoritatively fail the
          // durable backend job. Keep polling so a restarted Tauri process can
          // return the stored terminal state; enabling Retry here could launch
          // duplicate work while the original run is still alive.
          continue;
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

export async function listAgentRunsForConversation(
  chatId: string,
): Promise<AgentRun[]> {
  return (
    (await tauriInvoke<AgentRun[]>("agent_runs_for_conversation", {
      conversationId: chatId,
    })) ?? []
  );
}

const AGENT_RUN_READ_BATCH_SIZE = 8;

export async function listAgentRunsByIds(
  conversationId: string,
  runIds: string[],
): Promise<AgentRun[]> {
  const uniqueIds = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];
  const runs: AgentRun[] = [];
  for (let index = 0; index < uniqueIds.length; index += AGENT_RUN_READ_BATCH_SIZE) {
    const batch = uniqueIds.slice(index, index + AGENT_RUN_READ_BATCH_SIZE);
    const loaded = await tauriInvoke<AgentRun[]>("agent_runs_by_ids", {
      conversationId,
      runIds: batch,
    });
    if (loaded) runs.push(...loaded);
  }
  return runs;
}

export function latestAgentUsage(run: AgentRun | null): AgentTokenUsage | null {
  if (!run) return null;
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const usage = run.events[index].usage;
    if (usage) return usage;
  }
  return null;
}

interface HydratedAgentTool {
  errorText?: string;
  input: unknown;
  inputText: string;
  output?: unknown;
  state: DynamicToolUIPart["state"];
  title?: string;
  toolCallId: string;
  toolName: string;
}

interface AgentToolTransition {
  chunk: UIMessageChunk;
  tool?: HydratedAgentTool;
}

/** Rebuild the visible assistant timeline from one durable Agent run. */
export function messagePartsFromAgentRun(run: AgentRun): UIMessage["parts"] {
  const reasoning = run.events
    .filter((event) => event.kind === "reasoning-delta" && event.delta)
    .map((event) => event.delta)
    .join("");
  const tools = new Map<string, HydratedAgentTool>();

  for (const event of run.events) {
    const toolCallId = event.toolCallId?.trim();
    const transition = agentToolTransition(
      event,
      toolCallId ? tools.get(toolCallId) : undefined,
    );
    if (transition?.tool)
      tools.set(transition.tool.toolCallId, transition.tool);
  }

  const parts: UIMessage["parts"] = [];
  if (reasoning) {
    parts.push({ type: "reasoning", text: reasoning, state: "done" });
  }
  for (const tool of tools.values()) {
    parts.push(hydratedToolPart(tool));
  }
  const responseText =
    run.finalResponse ??
    run.events
      .filter((event) => event.kind === "delta" && event.delta)
      .map((event) => event.delta)
      .join("");
  if (responseText) parts.push({ type: "text", text: responseText });
  return parts;
}

function hydratedToolPart(tool: HydratedAgentTool): DynamicToolUIPart {
  const base = {
    type: "dynamic-tool" as const,
    toolName: tool.toolName,
    toolCallId: tool.toolCallId,
    ...(tool.title ? { title: tool.title } : {}),
  };
  if (tool.state === "output-available") {
    return {
      ...base,
      state: tool.state,
      input: tool.input,
      output: tool.output,
    };
  }
  if (tool.state === "output-error") {
    return {
      ...base,
      state: tool.state,
      input: tool.input,
      errorText: tool.errorText || "Tool failed.",
    };
  }
  if (tool.state === "input-available") {
    return { ...base, state: tool.state, input: tool.input };
  }
  return { ...base, state: "input-streaming", input: tool.input };
}

function parseHydratedToolInput(raw: string): unknown {
  const input = raw.trim();
  if (!input) return {};
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function agentToolTransition(
  event: AgentRunEvent,
  current?: HydratedAgentTool,
): AgentToolTransition | null {
  const toolCallId = event.toolCallId?.trim();
  if (!toolCallId) return null;
  const toolName = event.toolName?.trim() || current?.toolName;
  const tool = current
    ? { ...current }
    : toolName
      ? {
          input: {},
          inputText: "",
          state: "input-streaming" as const,
          toolCallId,
          toolName,
        }
      : undefined;
  if (tool && toolName) tool.toolName = toolName;
  if (tool && event.title?.trim()) tool.title = event.title.trim();

  switch (event.kind) {
    case "tool-input-start":
      if (!tool || !toolName) return null;
      tool.state = "input-streaming";
      return {
        tool,
        chunk: {
          type: "tool-input-start",
          toolCallId,
          toolName,
          dynamic: event.dynamic ?? true,
          title: event.title ?? undefined,
        },
      };
    case "tool-input-delta": {
      const inputTextDelta = event.inputTextDelta;
      if (!inputTextDelta) return null;
      if (tool) {
        tool.state = "input-streaming";
        tool.inputText += inputTextDelta;
        tool.input = parseHydratedToolInput(tool.inputText);
      }
      return {
        tool,
        chunk: { type: "tool-input-delta", toolCallId, inputTextDelta },
      };
    }
    case "tool-input-available":
      if (!tool || !toolName) return null;
      tool.state = "input-available";
      tool.input = event.input ?? parseHydratedToolInput(tool.inputText);
      return {
        tool,
        chunk: {
          type: "tool-input-available",
          toolCallId,
          toolName,
          input: tool.input,
          dynamic: event.dynamic ?? true,
          title: event.title ?? undefined,
        },
      };
    case "tool-input-error":
      if (!tool || !toolName) return null;
      tool.state = "output-error";
      tool.input = event.input ?? parseHydratedToolInput(tool.inputText);
      tool.errorText = event.errorText || "Tool input failed.";
      return {
        tool,
        chunk: {
          type: "tool-input-error",
          toolCallId,
          toolName,
          input: tool.input,
          errorText: tool.errorText,
          dynamic: event.dynamic ?? true,
          title: event.title ?? undefined,
        },
      };
    case "tool-output-available":
      if (tool) {
        tool.state = "output-available";
        tool.output = event.output;
      }
      return {
        tool,
        chunk: {
          type: "tool-output-available",
          toolCallId,
          output: event.output ?? {},
          dynamic: event.dynamic ?? true,
        },
      };
    case "tool-output-error": {
      const errorText = event.errorText || "Tool output failed.";
      if (tool) {
        tool.state = "output-error";
        tool.errorText = errorText;
      }
      return {
        tool,
        chunk: {
          type: "tool-output-error",
          toolCallId,
          errorText,
          dynamic: event.dynamic ?? true,
        },
      };
    }
    case "tool-output-denied":
      if (tool) {
        tool.state = "output-error";
        tool.errorText = "Tool use was denied.";
      }
      return {
        tool,
        chunk: { type: "tool-output-denied", toolCallId },
      };
    default:
      return null;
  }
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
  return {
    messageId,
    reasoningId,
    reasoningStarted: false,
    textId,
    tools: new Map<string, HydratedAgentTool>(),
  };
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
  const toolCallId = payload.toolCallId?.trim();
  const transition = agentToolTransition(
    payload,
    toolCallId ? ids.tools.get(toolCallId) : undefined,
  );
  if (!transition) return;
  if (transition.tool) {
    ids.tools.set(transition.tool.toolCallId, transition.tool);
  }
  enqueue(controller, transition.chunk);
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
