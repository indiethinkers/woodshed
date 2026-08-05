/**
 * Gmail-style "Show trimmed content" for plaintext bodies.
 *
 * Replies almost always carry the full history below the new text. Gmail
 * collapses that quoted section behind a toggle so the conversation reads
 * like a conversation instead of a stack of repeated quotes. This module
 * finds where the quoted section starts and — only when it's substantial —
 * splits the body so the UI can hide it.
 */

/**
 * A line that starts the quoted section. Covers the separators real mail
 * clients emit:
 *   - `> quoted text` (common prefix)
 *   - `On Tue, Aug 4, 2026 at 9:00 AM Jordan <j@x.com> wrote:` (Gmail/Apple)
 *   - `____________` (Gmail's plaintext separator)
 *   - `-----Original Message-----` / `---------- Forwarded message ----------`
 *     (Outlook / Gmail forwarded)
 *   - `From: ...` / `Sent: ...` blocks (Outlook replies)
 */
const QUOTE_START_RE =
  /^(?:>\s?|On\s+.+wrote:\s*$|_+\s*$|=+\s*$|-{3,}\s*$|--+ (?:Original|Forwarded) message --+\s*$|(?:From|Sent|To|Subject|Date|Cc):\s)/i;

const MIN_QUOTED_LINES = 4;

function isQuoteStartLine(line: string): boolean {
  return QUOTE_START_RE.test(line);
}

export interface SplitBody {
  /** The part of the body the sender actually wrote (trimmed). */
  body: string;
  /**
   * The trailing quoted history, or null when there is nothing worth
   * collapsing (no quote, or a footer too small to hide).
   */
  quoted: string | null;
}

export function splitQuotedBody(rawBody: string): SplitBody {
  const lines = rawBody.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isQuoteStartLine(lines[i]!)) {
      start = i;
      break;
    }
  }
  if (start < 0) return { body: rawBody, quoted: null };

  const quotedLines = lines.slice(start);
  // A tiny tail after a separator (e.g. a one-line "Sent from my iPhone"
  // signature) reads better in place than behind a toggle — only trim
  // when the history is actually noisy. Gmail's rule is line-based: a
  // block of several quoted lines is history, however short each line is.
  if (quotedLines.length < MIN_QUOTED_LINES) {
    return { body: rawBody, quoted: null };
  }

  return {
    body: lines.slice(0, start).join("\n").trimEnd(),
    quoted: quotedLines.join("\n").trim(),
  };
}
