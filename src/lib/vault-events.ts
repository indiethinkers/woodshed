import type { QueryClient } from "@tanstack/react-query";
import { woodshedClient } from "@/lib/woodshed-client";

// VaultChange payload shape, matching Rust src-tauri/src/watcher/mod.rs.
export type VaultChange =
  | { kind: "modified"; path: string }
  | { kind: "removed"; path: string };

export function invalidateAfterIndexRebuild(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ["emails"] });
  queryClient.invalidateQueries({ queryKey: ["tagTable"] });
  queryClient.invalidateQueries({ queryKey: ["tagsWithCounts"] });
}

// Path-routed query invalidation. Parses the changed path and invalidates
// only the matching query keys. Coarse fallback (`["tasks"]` invalidates
// everything) for paths that don't match a known shape.
//
// Path patterns:
//   tasks/<id>.md             → ["task", id], ["tasks"]
//   events/<id>.md            → ["event", id], ["events"]
//   cadence/YYYY-MM-DD.md     → ["dailyJournal", date]
//                                (journal body — events live in events/ now)
//   daily/YYYY-MM-DD.md       → ["dailyJournal", date]   (pre-migration vaults)
//   people/<id>.md            → ["people"]   (single-source cache; usePerson
//                                            selects by id from the list)
//   agent/<id>.md             → derived search/link caches only; AgentSurface
//                                owns its chat state locally.
//   resources/<id>.md         → ["resource", id], ["resources"]
//   inbox|sent|archive/<id>.md → ["email", id], ["emails"], ["thread"]
//   drafts/<id>.md            → ["drafts"]
//   areas/<id>.md             → ["areas"]
const DATE_FILENAME = /^\d{4}-\d{2}-\d{2}$/;

export function invalidateForPath(
  queryClient: QueryClient,
  path: string,
  _kind: VaultChange["kind"] = "modified",
): void {
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) {
    // Root-level Markdown is a valid Notebook record in an adopted folder.
    // There is no section name to route through the switch below, so refresh
    // the source list and every index-backed projection directly.
    if (segments.length === 1 && path.endsWith(".md")) {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      queryClient.invalidateQueries({ queryKey: ["search"] });
      queryClient.invalidateQueries({ queryKey: ["wikilinkTargets"] });
      queryClient.invalidateQueries({ queryKey: ["tagTable"] });
      queryClient.invalidateQueries({ queryKey: ["tagsWithCounts"] });
      queryClient.invalidateQueries({ queryKey: ["backlinks"] });
      queryClient.invalidateQueries({ queryKey: ["outgoingLinks"] });
    }
    return;
  }
  let [section, ...rest] = segments;

  // Adopted Markdown folders keep Woodshed-managed collections under the
  // visible `woodshed/` child. Strip that layout prefix so every existing
  // invalidation rule continues to describe the logical collection.
  if (section === "woodshed") {
    [section, ...rest] = rest;
    if (!section) return;
  }

  // `.woodshed/` is app-internal state, not user-authored vault content.
  // In particular, every atomic chat autosave snapshots the previous chat
  // under `.woodshed/revisions/agent/...`. Letting that hidden write fall
  // through the unknown-section fallback invalidated every React Query cache,
  // so an open person profile could collapse to "Person not found" as soon as
  // the sidebar agent accepted a prompt. Internal revisions cannot change any
  // rendered source record and must not participate in frontend invalidation.
  if (section === ".woodshed") {
    return;
  }

  const filename = rest.join("/").replace(/\.md$/, "");

  // External edits change the search index (the watcher refreshes it on
  // disk); drop the FTS query cache so the next palette query reflects them.
  queryClient.invalidateQueries({ queryKey: ["search"] });
  // Same index also feeds the wikilink resolver — refresh the target map
  // so links can resolve to records that were just created/renamed.
  queryClient.invalidateQueries({ queryKey: ["wikilinkTargets"] });
  // Tag tables scan record frontmatter/body and are used by generated tag
  // views plus area event aggregation. Any record edit can change membership.
  queryClient.invalidateQueries({ queryKey: ["tagTable"] });
  queryClient.invalidateQueries({ queryKey: ["tagsWithCounts"] });
  // Backlinks also derive from markdown bodies/titles across the vault.
  queryClient.invalidateQueries({ queryKey: ["backlinks"] });
  // Outgoing links are parsed from the edited record's title/body.
  queryClient.invalidateQueries({ queryKey: ["outgoingLinks"] });

  switch (section) {
    case "tasks":
      queryClient.invalidateQueries({ queryKey: ["task", filename] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      break;
    case "events":
      // events/<id>.md — per-event files. Invalidate the specific event by id
      // and every cached date's event list. Without the date in hand we can't
      // narrow the list invalidation, but event file mutations are rare
      // compared to journal keystrokes, so the dragnet is acceptable.
      queryClient.invalidateQueries({ queryKey: ["event", filename] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      break;
    case "cadence":
    case "calendar":
      // Cadence files are journal body only — events have moved to events/.
      // The journal-body autosave fires on every keystroke; invalidating
      // events here would refetch every cached date on each character.
      if (DATE_FILENAME.test(filename)) {
        queryClient.invalidateQueries({ queryKey: ["dailyJournal", filename] });
        // Un-migrated vault edge case: external edit to a daily file may
        // mutate inline events too. Narrow the invalidation to just that
        // date so it covers the legacy layout without refetching the whole
        // calendar on every keystroke. (Self-writes from the journal editor
        // are filtered out before reaching this listener.)
        queryClient.invalidateQueries({ queryKey: ["events", filename] });
      } else {
        // Legacy per-file event under cadence/<slug>-<date>.md (pre-migration).
        queryClient.invalidateQueries({ queryKey: ["event"] });
        queryClient.invalidateQueries({ queryKey: ["events"] });
      }
      break;
    case "daily":
      queryClient.invalidateQueries({ queryKey: ["dailyJournal", filename] });
      break;
    case "people":
      // usePerson derives from the same `["people"]` list that the
      // people index reads — no separate per-id cache to invalidate.
      // Refetching the list covers both "person updated" (row replaced)
      // and "person removed" (row drops out of the next snapshot).
      queryClient.invalidateQueries({ queryKey: ["people"] });
      // A person's name/email powers server-side attendee resolution on
      // events (`enrich_resolved_attendees` joins attendee emails/ids to
      // People). A new or edited person can match attendees in any event,
      // so refresh the schedule lists AND open event details so they
      // re-resolve — e.g. adding a contact lights up a previously-plain
      // attendee email as a linked person. External people edits are rare
      // vs. journal keystrokes, so the dragnet is acceptable (same
      // rationale as the events case above). Self-writes from the app's
      // own person mutations are filtered before reaching here, so this
      // only fires for genuine external edits.
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["event"] });
      break;
    case "notebook":
      // useNote selects from `["notes"]`; no per-id cache to refresh.
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      break;
    case "agent":
      // Agent chat files are first-class indexed vault records, so the
      // derived search/link caches above should refresh. They are not source
      // data for the current content surface, though; falling through to the
      // unknown-section dragnet made each chat autosave refetch unrelated
      // pages like Notebook while the agent stream was active.
      break;
    case "resources":
      queryClient.invalidateQueries({ queryKey: ["resource", filename] });
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      break;
    case "inbox":
    case "sent":
    case "archive":
      queryClient.invalidateQueries({ queryKey: ["email", filename] });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: ["thread"] });
      break;
    case "drafts":
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
      break;
    case "areas":
      // Area files (areas/<id>.md). Coarse invalidation of the list — the
      // areas query is cheap to refetch and there's no per-area cache key.
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      break;
    case "tables": {
      // Path shape: tables/<table-id>/_schema.md or tables/<table-id>/<row-id>.md.
      // Schema changes invalidate the table; row changes also bump the row list.
      const [tableId, ...tail] = rest;
      const tableLeaf = tail.join("/").replace(/\.md$/, "");
      if (!tableId) {
        queryClient.invalidateQueries({ queryKey: ["tables"] });
        break;
      }
      if (tableLeaf === "_schema" || tableLeaf === "") {
        queryClient.invalidateQueries({ queryKey: ["table", tableId] });
        queryClient.invalidateQueries({ queryKey: ["tables"] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["row", tableId, tableLeaf] });
        queryClient.invalidateQueries({ queryKey: ["rows", tableId] });
        queryClient.invalidateQueries({ queryKey: ["tables"] });
      }
      break;
    }
    default:
      // In an adopted Markdown tree, ordinary `.md` files outside the managed
      // subtree are Notebook records regardless of their original folder.
      if (path.endsWith(".md")) {
        queryClient.invalidateQueries({ queryKey: ["notes"] });
      } else {
        queryClient.invalidateQueries();
      }
  }
}

// Wires the Tauri `vault:changed` event to query invalidation. Returns an
// unsubscribe function. In Phase 0, the watcher is not yet emitting events
// from Rust, so this is a no-op until Phase 2 lands.
export function vaultEventListener(queryClient: QueryClient): () => void {
  return woodshedClient().subscribeVaultChanges((change) => {
    invalidateForPath(queryClient, change.path, change.kind);
  });
}
