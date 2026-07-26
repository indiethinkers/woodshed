"use client";

import { useQuery } from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";

export interface BacklinkEntry {
  source: string;
  title: string;
  href: string;
  type: string;
  preview?: string;
}

export function useBacklinks(target: string) {
  return useQuery<BacklinkEntry[]>({
    queryKey: ["backlinks", target],
    queryFn: async () => {
      const result = await tauriInvoke<BacklinkEntry[]>("wikilink_backlinks", {
        target,
      });
      return result ?? [];
    },
    enabled: target.trim().length > 0,
  });
}
