const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

const PERSON_COMMAND_RE =
  /\b(?:update|add|create|save|log|note)\b.*\b(?:person|contact|people|crm)\b|\b(?:person|contact|people|crm)\b.*\b(?:update|add|create|save|log|note)\b/i;

export function parseSweepPersonCommand(instruction: string): boolean {
  return PERSON_COMMAND_RE.test(instruction.trim());
}

export function extractEmailRecipients(raw?: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const match of raw.matchAll(EMAIL_RE)) {
    const email = match[0].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    recipients.push(email);
  }
  return recipients;
}

export function extractUrls(raw?: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of raw.matchAll(URL_RE)) {
    const url = normalizeUrl(match[0]);
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^fwd?:/i.test(trimmed)) return trimmed || "Forwarded message";
  return `Fwd: ${trimmed || "Forwarded message"}`;
}

function normalizeUrl(url: string): string {
  return url.replace(/[),.;:!?]+$/, "");
}
