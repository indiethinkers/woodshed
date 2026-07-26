"use client";

import { useQuery } from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";

export interface OutgoingLinkEntry {
  label: string;
  resolved: boolean;
  title?: string;
  href?: string;
  type?: string;
  path?: string;
}

export function useOutgoingLinks(source: string) {
  return useQuery<OutgoingLinkEntry[]>({
    queryKey: ["outgoingLinks", source],
    queryFn: async () => {
      const result = await tauriInvoke<OutgoingLinkEntry[]>("wikilink_outgoing", {
        source,
      });
      return result ?? [];
    },
    enabled: source.trim().length > 0,
  });
}
