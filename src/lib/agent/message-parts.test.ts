import type { DynamicToolUIPart, UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  agentToolDescriptor,
  messageTextFromMessage,
  toolNameFromPart,
  toolPartsFromMessage,
  toolStatusFromPart,
} from "./message-parts";

describe("messageTextFromMessage", () => {
  it("joins text parts and ignores structured parts", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Hello " },
        { type: "step-start" },
        { type: "text", text: "world" },
      ],
    } as UIMessage;

    expect(messageTextFromMessage(message)).toBe("Hello world");
  });
});

describe("toolPartsFromMessage", () => {
  it("extracts dynamic and static tool invocations with display names", () => {
    const dynamicTool: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "search_web",
      toolCallId: "call_1",
      state: "input-available",
      input: { query: "woodshed" },
    };
    const staticTool = {
      type: "tool-read_file",
      toolCallId: "call_2",
      state: "output-available",
      input: { path: "AGENTS.md" },
      output: { ok: true },
    };
    const message = {
      id: "assistant-tools",
      role: "assistant",
      parts: [{ type: "text", text: "Checking." }, dynamicTool, staticTool],
    } as UIMessage;

    const tools = toolPartsFromMessage(message);

    expect(tools).toHaveLength(2);
    expect(toolNameFromPart(tools[0])).toBe("search_web");
    expect(toolNameFromPart(tools[1])).toBe("read_file");
  });
});

describe("agentToolDescriptor", () => {
  it("prefers a server-supplied title and surfaces a hostname detail", () => {
    expect(
      agentToolDescriptor("web_fetch", "Reading hermesbible.com", {
        url: "https://www.hermesbible.com/docs",
      }),
    ).toEqual({
      label: "Reading hermesbible.com",
      description: "hermesbible.com",
    });
  });

  it("infers a web search verb and pulls the query out of the input", () => {
    expect(
      agentToolDescriptor("web_search", undefined, { query: "Hermes Bible" }),
    ).toEqual({ label: "Searching the web", description: "Hermes Bible" });
  });

  it("infers a page read and reduces a url to its host", () => {
    expect(
      agentToolDescriptor("fetch_url", undefined, {
        url: "https://example.com/a/b?c=d",
      }),
    ).toEqual({ label: "Reading a page", description: "example.com" });
  });

  it("routes vault tools to a vault verb", () => {
    expect(
      agentToolDescriptor("search_vault", undefined, { query: "1on1" }),
    ).toEqual({ label: "Searching your vault", description: "1on1" });
  });

  it("humanizes an unknown tool name", () => {
    expect(agentToolDescriptor("do_a_thing", undefined, {})).toEqual({
      label: "Do a thing",
      description: undefined,
    });
  });
});

describe("toolStatusFromPart", () => {
  const base = { type: "dynamic-tool" as const, toolName: "x", toolCallId: "1" };

  it("maps output to complete and errors/denials to error", () => {
    expect(
      toolStatusFromPart({
        ...base,
        state: "output-available",
        input: {},
        output: {},
      } as DynamicToolUIPart),
    ).toBe("complete");
    expect(
      toolStatusFromPart({
        ...base,
        state: "output-error",
        input: {},
        errorText: "boom",
      } as DynamicToolUIPart),
    ).toBe("error");
    expect(
      toolStatusFromPart({
        ...base,
        state: "output-denied",
        input: {},
      } as DynamicToolUIPart),
    ).toBe("error");
  });

  it("treats in-flight states as active", () => {
    expect(
      toolStatusFromPart({
        ...base,
        state: "input-available",
        input: {},
      } as DynamicToolUIPart),
    ).toBe("active");
  });
});
