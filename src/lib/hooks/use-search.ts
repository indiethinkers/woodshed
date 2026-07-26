"use client";

import { useEffect, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";

export interface SearchHit {
  kind: string;
  docId: string;
  path: string;
  title: string;
  hint?: string;
  href: string;
  area?: string;
}

export const SEARCH_DEBOUNCE_MS = 80;

/// Backend FTS5 search. Debounces the query so we don't fire one Tauri call
/// per keystroke; the query stays "stable" until the user stops typing for
/// SEARCH_DEBOUNCE_MS.
export function useSearch(query: string, limit = 30) {
  const debounced = useDebounced(query, SEARCH_DEBOUNCE_MS);
  return useQuery<SearchHit[]>({
    queryKey: ["search", debounced, limit],
    queryFn: async () => {
      const trimmed = debounced.trim();
      if (!trimmed) return [];
      const result = await tauriInvoke<SearchHit[]>("search", {
        query: trimmed,
        limit,
      });
      return result ?? [];
    },
    // Don't cache. Each keystroke gets a fresh hit so a record created
    // moments ago shows up the next time the same query is typed. TanStack
    // still dedupes concurrent calls for the same key, so we don't pay
    // double for rapid retyping.
    staleTime: 0,
    // Keep showing the previous query's results while the next request is
    // in flight. Prevents the command palette from blanking out between
    // keystrokes — the eye sees a smooth refinement rather than a flash.
    placeholderData: keepPreviousData,
  });
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/// Wipe and rebuild the search index from the vault. Wired to the
/// "Reset & re-scan" button in settings; on success, invalidate any open
/// search queries so the UI picks up the fresh data.
export function useReindex() {
  const qc = useQueryClient();
  return useMutation<number | null, Error, void>({
    mutationFn: async () => {
      const count = await tauriInvoke<number>("vault_reindex");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.invalidateQueries({ queryKey: ["search"] });
      return count;
    },
  });
}
