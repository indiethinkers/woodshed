/**
 * Wikilink resolver. Translates `[[Some Page]]` into a `{ href, label, type }`
 * lookup against the live vault.
 *
 * The data comes from the Rust `wikilink_targets` Tauri command (see
 * `src-tauri/src/commands/search.rs`), which dumps the FTS5 index. The
 * `WikilinkTargetsBridge` component (mounted in `Providers`) keeps the
 * cache warm via React Query — vault file changes invalidate the query,
 * the next fetch repopulates the cache.
 *
 * `resolveWikilink` stays synchronous so that read-only display components
 * (`<Wikilink>`, `<RichText>`) can use it inline without a hook ceremony.
 * The trade-off: on cold start, the cache is empty — wikilinks render as
 * unresolved (dotted underline) for one render cycle until the first fetch
 * lands. Eventually consistent.
 */

export interface WikilinkTargetRow {
  kind: string;
  docId: string;
  title: string;
  href: string;
}

export interface WikilinkTarget {
  href: string;
  label: string;
  type: string;
}

// Module-level cache populated by `WikilinkTargetsBridge`. Keyed by
// lowercased title AND lowercased docId so `[[Alex Rivera]]` and
// `[[alex-rivera]]` both resolve to the same record.
let wikilinkMap = new Map<string, WikilinkTarget>();

/**
 * Replace the resolver cache with a fresh snapshot. Called by the bridge
 * hook when the Rust query returns new data.
 */
export function setWikilinkTargets(rows: WikilinkTargetRow[]): void {
  const next = new Map<string, WikilinkTarget>();
  for (const row of rows) {
    const target: WikilinkTarget = {
      href: row.href,
      label: row.title,
      type: row.kind,
    };
    if (row.title) next.set(row.title.toLowerCase(), target);
    if (row.docId) next.set(row.docId.toLowerCase(), target);
  }
  wikilinkMap = next;
}

/**
 * Synchronously add a single row to the resolver cache. Used by the
 * wikilink picker after an in-app create so the inserted wikilink is
 * resolvable immediately, without waiting for the watcher → bridge
 * refetch round-trip. The next bridge refetch will write a fresh
 * snapshot (via `setWikilinkTargets`) which includes this entry too.
 */
export function addWikilinkTarget(row: WikilinkTargetRow): void {
  const target: WikilinkTarget = {
    href: row.href,
    label: row.title,
    type: row.kind,
  };
  if (row.title) wikilinkMap.set(row.title.toLowerCase(), target);
  if (row.docId) wikilinkMap.set(row.docId.toLowerCase(), target);
}

export function resolveWikilink(text: string): WikilinkTarget | null {
  return wikilinkMap.get(text.toLowerCase()) ?? null;
}
