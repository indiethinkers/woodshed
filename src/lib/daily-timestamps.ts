export const DAILY_TIMESTAMP_PATTERN = /^(\d{2}):(\d{2})$/;

export function formatDailyTimestamp(date: Date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function isDailyTimestamp(value: string): boolean {
  return DAILY_TIMESTAMP_PATTERN.test(value);
}

export function stripEmptyTimestampBulletsFromMarkdown(value: string): string {
  const lines = value.split(/\r?\n/);
  if (!lines.some(isEmptyTimestampBulletLine)) return value;
  return lines
    .filter(
      (line, index) =>
        !isEmptyTimestampBulletLine(line) ||
        ownsIndentedContinuation(lines, index),
    )
    .join("\n");
}

function ownsIndentedContinuation(lines: string[], index: number): boolean {
  const baseIndent = leadingWhitespaceLength(lines[index]);
  for (let next = index + 1; next < lines.length; next++) {
    if (!lines[next].trim()) continue;
    return leadingWhitespaceLength(lines[next]) > baseIndent;
  }
  return false;
}

function leadingWhitespaceLength(line: string): number {
  return line.length - line.trimStart().length;
}

function isEmptyTimestampBulletLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("-")) return false;
  const rest = trimmed.slice(1).trim();
  const match = rest.match(/^\[(\d{2}:\d{2})\]$/);
  return match ? isDailyTimestamp(match[1]) : false;
}
