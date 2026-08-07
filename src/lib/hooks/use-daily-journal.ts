"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toastMutationError } from "@/lib/mutation-toast";
import { tauriInvoke } from "@/lib/tauri";

export interface DailyJournalDto {
  date: string;
  path: string;
  body: string;
}

/**
 * Returns the daily journal for a given date. The Rust side has get-or-create
 * semantics: if the file doesn't exist, an empty journal file is written and
 * returned. Subsequent calls hit the existing file.
 */
export function useDailyJournal(date: string) {
  return useQuery<DailyJournalDto>({
    queryKey: ["dailyJournal", date],
    queryFn: async () => {
      const result = await tauriInvoke<DailyJournalDto>("daily_get", { date });
      if (!result) {
        // Browser-only fallback (vitest, no Tauri runtime). Return an empty
        // journal so the UI can still render a placeholder shell.
        return { date, path: `cadence/${date}.md`, body: "" };
      }
      return result;
    },
    enabled: !!date,
  });
}

export function useDailyJournalMutation() {
  const qc = useQueryClient();
  return useMutation<
    DailyJournalDto,
    Error,
    { date: string; body: string; previousBody?: string }
  >({
    mutationFn: async ({ date, body, previousBody }) => {
      let saved: DailyJournalDto | null;
      try {
        saved = await tauriInvoke<DailyJournalDto>("daily_save", {
          date,
          body,
          previousBody,
        });
      } catch (err) {
        // Optimistic-concurrency rejection: an external edit (Obsidian, etc.)
        // changed the file since this editor loaded, so the backend refused
        // to write our stale body over the newer content. Don't surface this as
        // a failure that drops the edit — re-read the fresh on-disk body (which
        // already contains the captured note) and seed it into the cache so the
        // editor re-hydrates to it via its external-value sync. The backend
        // prefixes the message with the `stale-base:` token so we can detect
        // this case; daily_get is the same get-or-create read the query uses.
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("stale-base:")) {
          const fresh = await tauriInvoke<DailyJournalDto>("daily_get", {
            date,
          });
          if (fresh) {
            qc.setQueryData(["dailyJournal", fresh.date], fresh);
            return fresh;
          }
          // No Tauri runtime (vitest fallback) — drop back to the cached body
          // rather than throwing, so the edit isn't lost.
          return (
            qc.getQueryData<DailyJournalDto>(["dailyJournal", date]) ?? {
              date,
              path: `cadence/${date}.md`,
              body,
            }
          );
        }
        throw err;
      }
      if (!saved) throw new Error("Tauri runtime missing");
      // Update the cache from inside mutationFn rather than onSuccess so
      // it survives the observer being torn down mid-flight. Concrete
      // repro: type a wikilink in today's journal and immediately click
      // it — DailyContent unmounts as the route changes to /people/<id>
      // before the Tauri save resolves, useMutation's onSuccess never
      // fires (it's bound to the now-dead observer), the cache keeps
      // serving the pre-save body, and navigating back shows the journal
      // without the wikilink even though it's correctly persisted to
      // disk. qc.setQueryData targets the global QueryClient and runs
      // regardless of which component (if any) is still mounted.
      qc.setQueryData(["dailyJournal", saved.date], saved);
      return saved;
    },
    onError: (err) => {
      toastMutationError("save journal", err);
    },
  });
}
