"use client";

import { useQuery } from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";

export interface ResolvedEdgeTarget {
  kind: string;
  docId: string;
  title: string;
  href: string;
}

export interface RecordEdgeRow {
  edgeType: string;
  target: string;
  ordinal: number;
  resolved?: ResolvedEdgeTarget;
}

export interface IncomingEdgeRow {
  sourcePath: string;
  edgeType: string;
  ordinal: number;
  sourceKind?: string;
  sourceTitle?: string;
  sourceHref?: string;
}

/**
 * Typed edges declared in a record's frontmatter (resource `people`,
 * event `attendees`, record `area`), each raw target resolved to a record
 * when one exists. Query key carries the path so vault:changed invalidation
 * refreshes it like other path-keyed reads.
 */
export function useRecordEdges(path: string) {
  return useQuery<RecordEdgeRow[]>({
    queryKey: ["record-edges", path],
    queryFn: async () => {
      const result = await tauriInvoke<RecordEdgeRow[]>("record_edges_get", {
        path,
      });
      return result ?? [];
    },
    enabled: path.trim().length > 0,
  });
}

/**
 * Every source record whose frontmatter references `path`'s record by id,
 * title, or (for people) email — "everything this person touches".
 */
export function useRecordEdgesIncoming(path: string) {
  return useQuery<IncomingEdgeRow[]>({
    queryKey: ["record-edges-incoming", path],
    queryFn: async () => {
      const result = await tauriInvoke<IncomingEdgeRow[]>(
        "record_edges_incoming",
        { path },
      );
      return result ?? [];
    },
    enabled: path.trim().length > 0,
  });
}
