import {
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";

export type AgentToolPart = ToolUIPart | DynamicToolUIPart;

export function messageTextFromMessage(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function toolPartsFromMessage(message: UIMessage): AgentToolPart[] {
  return message.parts.filter(isToolUIPart);
}

export function toolNameFromPart(part: AgentToolPart): string {
  return getToolName(part);
}

export type AgentToolStatus = "active" | "complete" | "error";

/** Map an AI SDK tool-part state onto the chain-of-thought step status. */
export function toolStatusFromPart(part: AgentToolPart): AgentToolStatus {
  switch (part.state) {
    case "output-available":
      return "complete";
    case "output-error":
    case "output-denied":
      return "error";
    default:
      return "active";
  }
}

export interface AgentToolDescriptor {
  label: string;
  description?: string;
}

/**
 * A human-friendly "what is the agent doing" line for a tool call. Prefers a
 * server-supplied title, otherwise infers an action verb from the tool name
 * (search / read / vault / mail / calendar), and pulls a query or hostname out
 * of the call input as a secondary detail line.
 */
export function agentToolDescriptor(
  name: string,
  title: string | undefined,
  input: unknown,
): AgentToolDescriptor {
  const query = extractToolQuery(input);
  const host = extractToolHost(input);
  if (title?.trim()) {
    return { label: title.trim(), description: host ?? query };
  }

  const slug = name.toLowerCase();
  if (/search|google|web|find|lookup/.test(slug) && !/vault|note/.test(slug)) {
    return { label: "Searching the web", description: query ?? host };
  }
  if (/fetch|read|open|browse|visit|scrape|crawl|url|page|http/.test(slug)) {
    return { label: "Reading a page", description: host ?? query };
  }
  if (/vault|note|file|grep|glob|markdown|index/.test(slug)) {
    return { label: "Searching your vault", description: query };
  }
  if (/mail|email|inbox|archive|message/.test(slug)) {
    return { label: "Working with mail", description: query };
  }
  if (/calendar|event|cadence|schedule|meeting/.test(slug)) {
    return { label: "Checking your calendar", description: query };
  }
  if (/task|todo/.test(slug)) {
    return { label: "Reviewing your tasks", description: query };
  }
  if (/people|person|contact|crm/.test(slug)) {
    return { label: "Looking up people", description: query };
  }
  return { label: humanizeToolName(name), description: host ?? query };
}

function humanizeToolName(name: string): string {
  const words = name
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  if (!words) return "Running a tool";
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function extractToolQuery(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["query", "q", "search", "search_query", "text", "prompt", "term", "question"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(value.trim(), 80);
    }
  }
  return undefined;
}

function extractToolHost(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["url", "uri", "href", "link", "address"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      try {
        return new URL(value.trim()).hostname.replace(/^www\./, "");
      } catch {
        return truncate(value.trim(), 80);
      }
    }
  }
  return undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
