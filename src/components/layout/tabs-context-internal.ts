import { createContext, useContext } from "react";

export interface OpenTab {
  /** Stable id, generated when the tab is opened. Survives title rewrites. */
  id: string;
  /** Per-tab back/forward stack. Newest navigation lives at the largest
   *  index reachable; entries past `cursor` are the "forward" stack and
   *  get truncated when the user navigates somewhere new. */
  history: string[];
  /** Index into `history` for the path the tab is currently showing. */
  cursor: number;
  /** Human-readable label rendered in the tab strip. */
  title: string;
}

/** Convenience accessor — the path this tab is currently displaying. */
export function tabPath(tab: OpenTab): string {
  return tab.history[tab.cursor];
}

/**
 * Advance a tab's private history for a navigation to `href`.
 *
 * - **push** (`isReplace = false`): append a new entry, truncating any
 *   "forward" stack past the cursor — same model as a browser tab.
 * - **replace** (`isReplace = true`): overwrite the current entry in place.
 *   The navigation reused the same browser-history slot (e.g. a note rename
 *   redirecting `/notebook/untitled` → `/notebook/my-title`), so pushing would
 *   leave the replaced-away URL in the back-stack and Back (⌘[) would land on
 *   a page that no longer exists. Overwriting keeps the stack honest.
 *
 * Title is intentionally left to the caller (it derives from `href`).
 */
export function advanceTabHistory(
  tab: OpenTab,
  href: string,
  isReplace: boolean,
): OpenTab {
  if (isReplace) {
    const history = [...tab.history];
    history[tab.cursor] = href;
    return { ...tab, history };
  }
  const history = tab.history.slice(0, tab.cursor + 1);
  history.push(href);
  return { ...tab, history, cursor: history.length - 1 };
}

/**
 * Map a native browser back/forward (trackpad swipe, mouse buttons) onto the
 * active tab's own cursor.
 *
 * The router uses browser history, but each tab keeps its own back-stack. When
 * a native gesture moves browser history by `delta` (negative = back, positive
 * = forward) and the new `href` is exactly the tab's adjacent entry in that
 * direction, it's the same move the tab's ⌘[ / ⌘] would make — so we step the
 * cursor instead of pushing a divergent entry (which is what left blank/stale
 * pages before). Returns the target cursor, or `null` when it isn't an
 * adjacent move (a genuine push, a replace, or a desynced gesture — all of
 * which fall back to the normal push/replace path). `delta` is `NaN` when the
 * history index is unavailable, and every comparison against `NaN` is false,
 * so this safely returns `null` then.
 */
export function adjacentNavCursor(
  tab: OpenTab,
  href: string,
  delta: number,
): number | null {
  if (delta < 0 && tab.cursor > 0 && tab.history[tab.cursor - 1] === href) {
    return tab.cursor - 1;
  }
  if (
    delta > 0 &&
    tab.cursor < tab.history.length - 1 &&
    tab.history[tab.cursor + 1] === href
  ) {
    return tab.cursor + 1;
  }
  return null;
}

export interface TabsContextType {
  tabs: OpenTab[];
  activeId: string | null;
  closeTab: (id: string) => void;
  /** Open a new empty tab pointed at "/". The "+" button in the title bar
   *  is the only way to grow the tab strip — every other navigation
   *  (Link clicks, command palette, redirects) replaces the active tab. */
  newTab: () => void;
  /** Append a new tab on the given path and make it active. Used by the
   *  ⌘T-triggered "open in new tab" flow in the command palette. */
  openInNewTab: (path: string) => void;
  /** Activate a tab by id and navigate to its path. Used by the title-bar
   *  tab strip itself. */
  selectTab: (id: string) => void;
  /** Move focus to the previous/next open tab. Used by the global
   *  ⌘⇧[ / ⌘⇧] shortcuts. */
  cycleTab: (delta: -1 | 1) => void;
  /** Move a tab so it lands at the position of `overId`. Active tab stays
   *  active — reordering doesn't navigate. */
  reorderTabs: (activeId: string, overId: string) => void;
  /** Step the active tab one entry back in its private history stack and
   *  navigate there. No-op when already at the oldest entry. */
  goBack: () => void;
  /** Step the active tab one entry forward in its private history stack
   *  and navigate there. No-op when already at the newest entry. */
  goForward: () => void;
}

// Lives in a non-JSX module so the Provider (which is the only component
// in tabs-context.tsx) can be Fast-Refreshed cleanly — modules that mix
// component and non-component exports fall back to a full reload in dev.
export const TabsContext = createContext<TabsContextType>({
  tabs: [],
  activeId: null,
  closeTab: () => {},
  newTab: () => {},
  openInNewTab: () => {},
  selectTab: () => {},
  cycleTab: () => {},
  reorderTabs: () => {},
  goBack: () => {},
  goForward: () => {},
});

export function useTabs() {
  return useContext(TabsContext);
}
