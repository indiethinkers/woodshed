export interface SweepTaskCommand {
  scheduled?: string;
  dateLabel?: string;
  content?: string;
}

export function parseSweepTaskCommand(
  instruction: string,
  now = new Date(),
): SweepTaskCommand | null {
  const normalized = instruction.toLocaleLowerCase();
  const turnIntoTask =
    /\bturn\s+(?:this(?:\s+(?:email|message))?|it|email|message)\s+into\s+(?:a\s+)?task\b/;
  const taskThis = /\btask\s+(?:this|it|email|message)\b/;

  if (
    /\b(?:do not|don't|dont|not)\s+(?:create|make|add)?\s*(?:a\s+)?task\b/.test(
      normalized,
    ) ||
    /\bno\s+task\b/.test(normalized)
  ) {
    return null;
  }

  const asksForTask =
    /\b(?:create|make|add)\s+(?:a\s+)?task\b/.test(normalized) ||
    /\b(?:create|make|add)\b.*\bas\s+(?:a\s+)?task\b/.test(normalized) ||
    turnIntoTask.test(normalized) ||
    taskThis.test(normalized);

  if (!asksForTask) return null;

  const content = taskContentFromInstruction(instruction);

  if (/\btomorrow\b/.test(normalized)) {
    return {
      scheduled: formatLocalDate(addLocalDays(now, 1)),
      dateLabel: "tomorrow",
      ...(content ? { content } : {}),
    };
  }

  if (/\btoday\b/.test(normalized)) {
    return {
      scheduled: formatLocalDate(now),
      dateLabel: "today",
      ...(content ? { content } : {}),
    };
  }

  return content ? { content } : {};
}

function taskContentFromInstruction(instruction: string): string | undefined {
  const compact = instruction.trim().replace(/\s+/g, " ");
  const patterns = [
    /\bremind(?:ing)?\s+me\s+to\s+(.+)$/i,
    /\b(?:create|make|add)\s+(?:a\s+)?task\s+to\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (!match) continue;
    const content = cleanTaskContent(match[1]);
    if (content) return sentenceCase(content);
  }
  return undefined;
}

function cleanTaskContent(value: string): string {
  return value
    .replace(/\b(?:today|tomorrow)\b[.!?]*$/i, "")
    .replace(/^[\s:,-]+|[\s.,;:!?]+$/g, "")
    .trim();
}

function sentenceCase(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function addLocalDays(value: Date, days: number): Date {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate() + days,
  );
}

function formatLocalDate(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
