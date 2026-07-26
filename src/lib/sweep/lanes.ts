// Lane bucketing for the Sweep board tabs: To review / Queued / Working / Done.

import type { EmailSummary } from "../mail-lib/types";
import type { SweepCard, SweepStatus } from "./types";

export const LANES: ReadonlyArray<{ id: SweepStatus; label: string }> = [
  { id: "to_review", label: "To review" },
  { id: "queued", label: "Queued" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
];

export type SweepLaneRows = Record<SweepStatus, SweepLaneRow[]>;

export interface SweepLaneRow {
  id: string;
  email: EmailSummary | null;
  card: SweepCard | null;
}

/** A card snoozed to a future time drops out of the active review flow. */
export function isSnoozed(card: SweepCard, now: Date = new Date()): boolean {
  if (!card.snoozeUntil) return false;
  const until = new Date(card.snoozeUntil);
  return !Number.isNaN(until.getTime()) && until.getTime() > now.getTime();
}

/** Map emailId → its sweep card (if any). */
export function cardsByEmail(cards: SweepCard[]): Map<string, SweepCard> {
  const byEmail = new Map<string, SweepCard>();
  for (const card of cards) byEmail.set(card.emailId, card);
  return byEmail;
}

/**
 * The lane an email belongs to: its card's status, or "to_review" when it
 * hasn't been triaged yet. A to_review card snoozed into the future is hidden
 * (null) until the snooze elapses.
 */
export function laneForEmail(
  emailId: string,
  byEmail: Map<string, SweepCard>,
  now: Date = new Date(),
): SweepStatus | null {
  const card = byEmail.get(emailId);
  if (!card) return "to_review";
  if (card.status === "to_review" && isSnoozed(card, now)) return null;
  return card.status;
}

/**
 * Build the visible rows for every sweep lane. Cards are the source of truth
 * for queued/working/done, so completed cards remain visible even after their
 * source email leaves inbox/. Emails without cards still enter To review.
 *
 * A `to_review` card is the exception: it represents pending review of an
 * inbox message, so once its source email is gone from inbox/ (archived or
 * handled directly in Gmail) the card is stale and is dropped from Review
 * rather than rendered as an email-less placeholder. (The backend prunes
 * these files via `sweep_discard_orphans`; this guard keeps the UI correct
 * even before that runs.)
 */
export function rowsByLane(
  emails: EmailSummary[],
  cards: SweepCard[],
  now: Date = new Date(),
): SweepLaneRows {
  const rows: SweepLaneRows = {
    to_review: [],
    queued: [],
    working: [],
    done: [],
  };
  const emailById = new Map(emails.map((email) => [email.id, email]));
  const seen = new Set<string>();

  for (const card of cards) {
    if (card.status === "to_review" && isSnoozed(card, now)) continue;
    if (card.status === "to_review" && !emailById.has(card.emailId)) continue;
    rows[card.status].push({
      id: card.emailId,
      email: emailById.get(card.emailId) ?? null,
      card,
    });
    seen.add(card.emailId);
  }

  for (const email of emails) {
    if (seen.has(email.id)) continue;
    rows.to_review.push({ id: email.id, email, card: null });
  }

  return rows;
}
