"use client";

import { useQuery } from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";
import type { EventDto } from "./use-events";

export interface TagTableRow {
  id: string;
  title: string;
  type:
    | "event"
    | "task"
    | "note"
    | "person"
    | "resource"
    | "area"
    | "mail"
    | "row"
    | string;
  date: string;
  area: string;
  path: string;
  event?: EventDto;
}

export interface TagCount {
  tag: string;
  count: number;
  created: string | null;
}

// Shared query definitions so the hooks and the startup prefetch
// (src/components/layout/providers.tsx) reference one source of truth and
// can't drift on queryKey / queryFn / enabled.
export function tagTableQueryOptions(tag: string) {
  return {
    queryKey: ["tagTable", tag] as const,
    queryFn: async () =>
      (await tauriInvoke<TagTableRow[]>("tag_table", { tag })) ?? [],
    enabled: tag.trim().length > 0,
  };
}

export function tagsWithCountsQueryOptions() {
  return {
    queryKey: ["tagsWithCounts"] as const,
    queryFn: async () =>
      (await tauriInvoke<TagCount[]>("tags_with_counts")) ?? [],
  };
}

export function useTagTable(tag: string) {
  return useQuery<TagTableRow[]>(tagTableQueryOptions(tag));
}

export function useTagsWithCounts() {
  return useQuery<TagCount[]>(tagsWithCountsQueryOptions());
}
