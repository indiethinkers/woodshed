"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * Resolve a route's display title from TanStack cache when the URL slug is
 * a stable id (so renaming the entity doesn't change the URL). Tabs and
 * breadcrumbs both call this — when a note/person/event/task is renamed,
 * the cached entity updates and any subscriber re-renders with the live
 * title. Falls back to the caller-provided slug-derived label when the
 * cache hasn't loaded the entity yet (cold tab on app boot, etc.).
 *
 * `useQuery` with `enabled: false` subscribes to cache mutations without
 * triggering a fetch — exactly what we want here.
 *
 * Two cache shapes are supported:
 *   - `field`: cached value is the DTO itself; pluck a property.
 *   - `selectFromList`: cached value is the LIST; resolve the row first,
 *     then pluck. Used by types whose source of truth is the shared list
 *     query (`["people"]`), with no separate per-id cache.
 */
export function useResolvedRouteTitle(
  href: string,
  fallback: string,
): string {
  const pathname = stripSearchAndHash(href);
  const match = matchTitleRoute(pathname);
  const query = useQuery<unknown>({
    queryKey: match?.key ?? ["__route_title_none__"],
    // Cache-only: never fetches. The list/detail hook is the canonical
    // source for these keys; we just subscribe to their cache entries
    // here. TanStack still requires a queryFn even when enabled is
    // false, so we hand it a noop.
    queryFn: () => null,
    enabled: false,
  });
  if (!match) return fallback;
  const data = query.data;
  if (data == null) return fallback;
  const record = match.selectFromList
    ? match.selectFromList(data)
    : (data as Record<string, unknown>);
  if (!record || typeof record !== "object") return fallback;
  const value = (record as Record<string, unknown>)[match.field];
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function stripSearchAndHash(href: string): string {
  const queryIdx = href.indexOf("?");
  const hashIdx = href.indexOf("#");
  const end = [queryIdx, hashIdx]
    .filter((idx) => idx !== -1)
    .reduce((min, idx) => Math.min(min, idx), href.length);
  return href.slice(0, end) || "/";
}

interface RouteMatch {
  key: readonly unknown[];
  /** Property on the resolved record whose value is the display title. */
  field: string;
  /** Optional projector when the cache value is a list (e.g. `["people"]`).
   *  Returns the record to pluck `field` from, or null if no match. */
  selectFromList?: (cached: unknown) => Record<string, unknown> | null;
}

function matchTitleRoute(pathname: string): RouteMatch | null {
  let m: RegExpMatchArray | null;
  if ((m = pathname.match(/^\/mail\/(.+)$/))) {
    // Mail ids can contain characters that TanStack encodes in route
    // params. Decode once so the cache key matches useEmail().
    let decoded = m[1];
    try {
      decoded = decodeURIComponent(m[1]);
    } catch {
      // Already decoded or malformed — fall through with the raw slug.
    }
    return { key: ["email", decoded], field: "subject" };
  }
  if ((m = pathname.match(/^\/notebook\/(.+)$/))) {
    const id = m[1];
    return {
      key: ["notes"],
      field: "title",
      selectFromList: (cached) => {
        if (!Array.isArray(cached)) return null;
        const row = (cached as Array<Record<string, unknown>>).find(
          (n) => n?.id === id,
        );
        return row ?? null;
      },
    };
  }
  if ((m = pathname.match(/^\/resources\/(.+)$/))) {
    return { key: ["resource", m[1]], field: "title" };
  }
  if ((m = pathname.match(/^\/databases\/([^/]+)$/))) {
    // Skip the static /databases/custom/<name> shape — only the vault-backed
    // /databases/<id> shape resolves through the table cache.
    if (m[1] === "custom") return null;
    return { key: ["table", m[1]], field: "name" };
  }
  if ((m = pathname.match(/^\/people\/(.+)$/))) {
    const id = m[1];
    return {
      key: ["people"],
      field: "name",
      // The list query is the single source of truth for people; pick
      // the row before plucking the name.
      selectFromList: (cached) => {
        if (!Array.isArray(cached)) return null;
        const row = (cached as Array<Record<string, unknown>>).find(
          (p) => p?.id === id,
        );
        return row ?? null;
      },
    };
  }
  if ((m = pathname.match(/^\/cadence\/event\/ical\/([^/]+)\/(.+)$/))) {
    // iCal event detail — useIcalEvent keys on the *decoded* (accountId,
    // externalId) tuple, so the route key has to match that shape.
    let account = m[1];
    let external = m[2];
    try {
      account = decodeURIComponent(account);
      external = decodeURIComponent(external);
    } catch {
      // already decoded or malformed — fall through with raw segments
    }
    return { key: ["event", "ical", account, external], field: "title" };
  }
  if ((m = pathname.match(/^\/cadence\/event\/(.+)$/))) {
    return { key: ["event", m[1]], field: "title" };
  }
  if ((m = pathname.match(/^\/cadence\/[^/]+\/task\/([^/]+)$/))) {
    return { key: ["task", m[1]], field: "content" };
  }
  return null;
}
