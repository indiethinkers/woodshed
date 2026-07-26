"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";
import {
  setWikilinkTargets,
  type WikilinkTargetRow,
} from "@/lib/wikilinks";

const QUERY_KEY = ["wikilinkTargets"] as const;

interface UseWikilinkTargetsOptions {
  enabled?: boolean;
}

/**
 * Fetches the full list of wikilink-resolvable records from the Rust FTS5
 * index (one bulk listing). The result is mirrored into a module-level
 * cache in `src/lib/wikilinks.ts` so the synchronous `resolveWikilink(text)`
 * keeps working for the read-only `<Wikilink>` and `<RichText>` components.
 *
 * Cache invalidation happens via the existing vault-events listener
 * (path-routed `queryClient.invalidateQueries`) — when any record changes,
 * the next fetch repopulates the resolver map.
 */
export function useWikilinkTargets(options: UseWikilinkTargetsOptions = {}) {
  const enabled = options.enabled ?? true;
  const query = useQuery<WikilinkTargetRow[]>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const rows = await tauriInvoke<WikilinkTargetRow[]>("wikilink_targets");
      return rows ?? [];
    },
    enabled,
    // staleTime: Infinity means we only refetch on explicit invalidation.
    // The vault-events listener invalidates this key on every file change.
    staleTime: Infinity,
  });

  // Mirror into module-level cache whenever the data changes. Wrapped in
  // useEffect so render stays pure.
  useEffect(() => {
    if (enabled && query.data) {
      setWikilinkTargets(query.data);
    }
  }, [enabled, query.data]);

  return query;
}
