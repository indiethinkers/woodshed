// Invoke wrappers for the Inbox Sweep Tauri commands. Tauri maps camelCase
// JS arg keys to the snake_case Rust params (emailId → email_id, etc.).

import { tauriInvoke } from "@/lib/tauri";
import type { SweepCard, SweepCommandPlan } from "./types";

/** All sweep cards on disk, newest activity first. */
export async function sweepCardsAll(): Promise<SweepCard[]> {
  return (await tauriInvoke<SweepCard[]>("sweep_cards_all")) ?? [];
}

/**
 * Triage one inbox email: pushes its text to Hermes (which reads its own
 * vault clone for context), parses the result, and writes the card. Returns
 * the card; null only outside the Tauri shell.
 */
export async function sweepTriageEmail(emailId: string): Promise<SweepCard | null> {
  return await tauriInvoke<SweepCard>("sweep_triage_email", { emailId });
}

/** Re-draft a card from the command bar ("make it warmer", etc.). */
export async function sweepCardRefine(
  cardId: string,
  instruction: string,
): Promise<SweepCard | null> {
  return await tauriInvoke<SweepCard>("sweep_card_refine", { cardId, instruction });
}

/** Plan executable card actions from a freeform command-bar instruction. */
export async function sweepCardPlanActions(
  cardId: string,
  instruction: string,
): Promise<SweepCommandPlan | null> {
  return await tauriInvoke<SweepCommandPlan>("sweep_card_plan_actions", {
    cardId,
    instruction,
  });
}

/** Persist an edited card (draft tweak, lane change, snooze). */
export async function sweepCardSave(card: SweepCard): Promise<SweepCard | null> {
  return await tauriInvoke<SweepCard>("sweep_card_save", { card });
}

/**
 * Delete stale `to_review` cards whose source email is no longer in the
 * inbox (handled directly in Gmail, then reconciled out). Returns the
 * number removed. Called after a refresh so the Review lane reflects what's
 * actually still in the inbox.
 */
export async function sweepDiscardOrphans(): Promise<number> {
  return (await tauriInvoke<number>("sweep_discard_orphans")) ?? 0;
}
