"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  sweepCardPlanActions,
  sweepCardRefine,
  sweepCardSave,
  sweepCardsAll,
  sweepTriageEmail,
} from "@/lib/sweep";
import type { SweepCard, SweepCommandPlan } from "@/lib/sweep/types";

/**
 * All sweep cards from disk. The watcher filters our own writes (so the UI
 * doesn't flicker), which means mutations below invalidate `["sweep"]`
 * explicitly; external edits to `sweep/` invalidate via vault-events.ts.
 */
export function useSweepCards() {
  return useQuery<SweepCard[]>({
    queryKey: ["sweep"],
    queryFn: () => sweepCardsAll(),
  });
}

/** Triage a single inbox email into a card. */
export function useTriageEmail() {
  const qc = useQueryClient();
  return useMutation<SweepCard | null, Error, string>({
    mutationFn: (emailId) => sweepTriageEmail(emailId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sweep"] }),
  });
}

/** Re-draft a card from the command bar. */
export function useRefineCard() {
  const qc = useQueryClient();
  return useMutation<SweepCard | null, Error, { cardId: string; instruction: string }>(
    {
      mutationFn: ({ cardId, instruction }) => sweepCardRefine(cardId, instruction),
      onSuccess: () => qc.invalidateQueries({ queryKey: ["sweep"] }),
    },
  );
}

/** Translate a freeform command into executable card actions. */
export function usePlanCardActions() {
  return useMutation<
    SweepCommandPlan | null,
    Error,
    { cardId: string; instruction: string }
  >({
    mutationFn: ({ cardId, instruction }) =>
      sweepCardPlanActions(cardId, instruction),
  });
}

/** Persist an edited card (draft tweak, lane change, snooze). */
export function useSaveCard() {
  const qc = useQueryClient();
  return useMutation<SweepCard | null, Error, SweepCard>({
    mutationFn: (card) => sweepCardSave(card),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sweep"] }),
  });
}
