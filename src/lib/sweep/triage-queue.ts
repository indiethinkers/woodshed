// Triage orchestration: walk the inbox and triage emails that don't yet have
// a card, with bounded concurrency so we don't fan out 50 Hermes calls at once.

import type { EmailSummary } from "@/lib/mail-lib/types";
import type { SweepCard } from "./types";

/** Inbox emails that don't yet have a sweep card, in inbox order. */
export function pendingEmailIds(
  emails: EmailSummary[],
  cards: SweepCard[],
): string[] {
  const swept = new Set(cards.map((c) => c.emailId));
  return emails.filter((e) => !swept.has(e.id)).map((e) => e.id);
}

/**
 * Run an async task over ids with bounded concurrency. A failed id is skipped
 * so one bad email never stalls the whole sweep. Honors an AbortSignal.
 */
export async function runTriageQueue(
  ids: string[],
  triageOne: (id: string) => Promise<unknown>,
  opts: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      if (opts.signal?.aborted) return;
      const id = ids[cursor++];
      try {
        await triageOne(id);
      } catch {
        // Skip a failed email; the queue keeps going.
      }
    }
  };
  const workers = Math.min(concurrency, Math.max(ids.length, 1));
  await Promise.all(Array.from({ length: workers }, worker));
}
