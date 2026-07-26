import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useRouterState, useNavigate } from "@tanstack/react-router";
import {
  adjacentNavCursor,
  advanceTabHistory,
  TabsContext,
  tabPath,
  type OpenTab,
} from "./tabs-context-internal";
import {
  rememberContentScroll,
  requestContentScrollRestore,
} from "@/lib/content-scroll-memory";
import { isTauriRuntime } from "@/lib/runtime";

const VIEW_LABELS: Record<string, string> = {
  people: "People",
  mail: "Mail",
  cadence: "Cadence",
  notebook: "Notebook",
  databases: "Databases",
  resources: "Resources",
  areas: "Areas",
  agent: "Agent",
  settings: "Settings",
};

/**
 * Derive a display title from a route href. Mirrors the breadcrumb labelling
 * so a tab and its breadcrumb agree on what the page is called. The tab
 * history stores full hrefs so iCal occurrence routes keep their ?date= query.
 */
function titleFor(href: string): string {
  const pathname = stripSearchAndHash(href);
  if (pathname === "/" || /^\/cadence(\/|$)/.test(pathname)) {
    const m = pathname.match(/^\/cadence\/(\d{4}-\d{2}-\d{2})/);
    if (m) {
      const d = new Date(m[1] + "T00:00:00");
      return d.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    }
    return "Cadence";
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "Home";
  if (segments.length === 1) {
    return VIEW_LABELS[segments[0]] ?? segments[0];
  }
  const slug = segments.slice(1).join("/");
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function stripSearchAndHash(href: string): string {
  const queryIdx = href.indexOf("?");
  const hashIdx = href.indexOf("#");
  const end = [queryIdx, hashIdx]
    .filter((idx) => idx !== -1)
    .reduce((min, idx) => Math.min(min, idx), href.length);
  return href.slice(0, end) || "/";
}

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `tab_${Date.now().toString(36)}_${_idCounter}`;
}

function currentContentScrollTop(): number {
  const viewport = document.querySelector<HTMLElement>(
    "[data-woodshed-content-scroll]",
  );
  return viewport?.scrollTop ?? 0;
}

function rememberTabContentScroll(tab: OpenTab | undefined) {
  if (!tab) return;
  rememberContentScroll(tab.id, tabPath(tab), currentContentScrollTop());
}

function requestTabContentScrollRestore(tab: OpenTab | undefined) {
  if (!tab) return;
  requestContentScrollRestore(tab.id, tabPath(tab));
}

interface TabsState {
  tabs: OpenTab[];
  activeId: string;
  /** Full route href this state was last reconciled against — lets us notice
   *  the route changed without leaning on a useEffect. */
  syncedHref: string;
  /** Browser-history index (`location.state.__TSR_index`) at the last sync.
   *  A push advances it; a replace leaves it unchanged. Comparing it on the
   *  next href change is how we tell a replace from a push so we don't leave a
   *  replaced-away URL in the tab's back-stack. `NaN` when the index isn't
   *  available — then every navigation degrades to a push (the prior behavior),
   *  never a spurious replace. */
  syncedIndex: number;
}

/**
 * Tracks the set of open tabs and which one is active.
 *
 * Replace-by-default semantics: navigating to a path the active tab
 * doesn't already show updates the active tab in place — no new tab
 * spawns. Hitting the "+" button in the title bar is the explicit way
 * to grow the strip; everything else (Link clicks, command palette,
 * router.replace redirects) reuses the current tab.
 *
 * If the target path matches a *different* open tab, that tab is
 * activated rather than producing a duplicate.
 */
export function TabsProvider({ children }: { children: ReactNode }) {
  const href = useRouterState({ select: (s) => s.location.href });
  // History index behind the current entry. Advances on push, holds on
  // replace — the signal we use to keep the tab back-stack honest across
  // `replace` navigations (redirects, note/record renames). `NaN` if the
  // field is ever absent, which makes the replace check fail closed (push).
  const historyIndex = useRouterState({
    select: (s) =>
      (s.location.state as { __TSR_index?: number } | undefined)?.__TSR_index ??
      NaN,
  });
  const navigate = useNavigate();

  const [state, setState] = useState<TabsState>(() => {
    const seed: OpenTab = {
      id: nextId(),
      history: [href],
      cursor: 0,
      title: titleFor(href),
    };
    return {
      tabs: [seed],
      activeId: seed.id,
      syncedHref: href,
      syncedIndex: historyIndex,
    };
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  // React-recommended pattern for state that derives from a changing input:
  // compare the synced value against the current input during render and
  // call setState immediately. Cleaner than a useEffect-and-set pattern,
  // and avoids the "set-state-in-effect" anti-pattern.
  if (state.syncedHref !== href) {
    setState((prev) => {
      // Already an active tab on this path? Nothing to do. (Covers every
      // tab-internal nav — goBack/goForward/selectTab/newTab — which moved the
      // cursor themselves before navigating, so href already matches.)
      const active = prev.tabs.find((t) => t.id === prev.activeId);
      if (active && tabPath(active) === href) {
        return { ...prev, syncedHref: href, syncedIndex: historyIndex };
      }

      // How far browser history moved since the last sync: <0 back, 0 replace
      // (same slot), >0 push/forward. `NaN` when the index is unavailable.
      const delta = historyIndex - prev.syncedIndex;
      // A native back/forward (trackpad swipe, mouse buttons) that lands on the
      // active tab's adjacent entry is the same move ⌘[ / ⌘] would make — step
      // the cursor rather than pushing a divergent entry. Checked before the
      // tab-switch branch so a gesture stays in the active tab.
      const adjacentCursor = active
        ? adjacentNavCursor(active, href, delta)
        : null;

      if (adjacentCursor === null) {
        // Another (non-active) tab is already on this path — switch to it.
        const existing = prev.tabs.find(
          (t) => tabPath(t) === href && t.id !== prev.activeId,
        );
        if (existing) {
          const newTitle = titleFor(href);
          const tabs =
            existing.title === newTitle
              ? prev.tabs
              : prev.tabs.map((t) =>
                  t.id === existing.id ? { ...t, title: newTitle } : t,
                );
          return {
            tabs,
            activeId: existing.id,
            syncedHref: href,
            syncedIndex: historyIndex,
          };
        }
      }

      // Advance the active tab. Either a native back/forward (move the cursor
      // to the matched neighbor) or a fresh navigation: a replace overwrites
      // the current entry in place (same history slot), a push appends one and
      // truncates the forward stack. See `advanceTabHistory`.
      const isReplace = !Number.isNaN(delta) && delta === 0;
      const tabs = prev.tabs.map((t) => {
        if (t.id !== prev.activeId) return t;
        if (adjacentCursor !== null) {
          return { ...t, cursor: adjacentCursor, title: titleFor(href) };
        }
        return { ...advanceTabHistory(t, href, isReplace), title: titleFor(href) };
      });
      return {
        tabs,
        activeId: prev.activeId,
        syncedHref: href,
        syncedIndex: historyIndex,
      };
    });
  }

  const closeTab = useCallback(
    (id: string) => {
      const prev = stateRef.current;
      const idx = prev.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const wasActive = prev.tabs[idx].id === prev.activeId;
      if (wasActive) rememberTabContentScroll(prev.tabs[idx]);
      const nextTabs = prev.tabs.filter((t) => t.id !== id);
      let target: string | null = null;

      if (nextTabs.length === 0) {
        // Always keep at least one tab open — fall back to "/". Keep
        // syncedHref pinned to the *current* href so the render-phase
        // reconciler doesn't fire mid-flight and misroute the navigation.
        // It'll catch up to the fallback's path once navigate() resolves.
        const fallback: OpenTab = {
          id: nextId(),
          history: ["/"],
          cursor: 0,
          title: "Cadence",
        };
        target = "/";
        flushSync(() => {
          setState({
            tabs: [fallback],
            activeId: fallback.id,
            syncedHref: prev.syncedHref,
            syncedIndex: prev.syncedIndex,
          });
        });
      } else if (wasActive) {
        const neighbor = nextTabs[Math.max(0, idx - 1)];
        target = tabPath(neighbor);
        requestTabContentScrollRestore(neighbor);
        flushSync(() => {
          setState({
            tabs: nextTabs,
            activeId: neighbor.id,
            syncedHref: prev.syncedHref,
            syncedIndex: prev.syncedIndex,
          });
        });
      } else {
        flushSync(() => {
          setState({ ...prev, tabs: nextTabs });
        });
      }

      // The neighbor's current path is a runtime string captured from past
      // navigation — use the router's `href` option (raw href) rather
      // than `to` (typed-route-literal).
      if (target) void navigate({ href: target });
    },
    [navigate],
  );

  const newTab = useCallback(() => {
    rememberTabContentScroll(
      stateRef.current.tabs.find((t) => t.id === stateRef.current.activeId),
    );
    // Append a fresh tab to the strip *before* navigating so the path-sync
    // logic recognises it on the next render and doesn't replace the
    // active tab instead. Keep syncedHref pinned to the *current* href
    // — if we set it ahead to "/", the render-phase reconciler would fire
    // mid-flight, find an existing tab matching the old href, and
    // switch activeId back to it before the router catches up.
    setState((prev) => {
      const fresh: OpenTab = {
        id: nextId(),
        history: ["/"],
        cursor: 0,
        title: "Cadence",
      };
      return {
        tabs: [...prev.tabs, fresh],
        activeId: fresh.id,
        syncedHref: prev.syncedHref,
        syncedIndex: prev.syncedIndex,
      };
    });
    void navigate({ to: "/" });
  }, [navigate]);

  const openInNewTab = useCallback(
    (path: string) => {
      rememberTabContentScroll(
        stateRef.current.tabs.find((t) => t.id === stateRef.current.activeId),
      );
      // Same shape as newTab(), but seeded with a concrete path so we
      // don't navigate through "/" first — that would briefly flash the
      // Cadence page and, more importantly, leave a "/" tab in the strip
      // if navigation never completed. Intentionally NOT de-duped:
      // ⌘T-then-select is an explicit "I want a new tab" gesture, so a
      // duplicate path is the right outcome (same rule as the "+" button).
      setState((prev) => {
        const fresh: OpenTab = {
          id: nextId(),
          history: [path],
          cursor: 0,
          title: titleFor(path),
        };
        return {
          tabs: [...prev.tabs, fresh],
          activeId: fresh.id,
          syncedHref: prev.syncedHref,
          syncedIndex: prev.syncedIndex,
        };
      });
      // `href` rather than `to` because callers pass runtime-built
      // hrefs (FTS5 hits, date keywords) that aren't typed routes.
      void navigate({ href: path });
    },
    [navigate],
  );

  // Shift+Cmd/Ctrl+click an internal link → open it in a new tab and switch
  // to it. Pure Shift+click is owned by RightSidebarProvider, which opens
  // the link in the references pane instead.
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.button !== 0 || !event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a");
      if (!anchor) return;
      if (anchor.target === "_blank") return;
      // Only internal app paths (`/people/…`, `/cadence/…`). External URLs,
      // `mailto:`, in-page `#anchor`, and href-less editor wikilinks are
      // skipped — `getAttribute` keeps the raw "/…" rather than the
      // origin-resolved absolute URL the `.href` property would give.
      const href = anchor.getAttribute("href");
      if (!href || !href.startsWith("/")) return;
      event.preventDefault();
      event.stopPropagation();
      openInNewTab(href);
    }
    // Capture phase so we run before TanStack Link's own click handler and
    // can stop it from navigating the current tab.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [openInNewTab]);

  // ⌘W closes the active tab when more than one is open, instead of the whole
  // window. With a single tab there's nothing to close but the window, so we
  // fall through to closing it (preserving the prior behaviour). The macOS
  // menu leaves ⌘W unbound (see lib.rs) so this keydown actually fires; ⇧⌘W
  // still closes the window via the menu. Tauri-only — in a browser ⌘W is the
  // user-agent's own close-tab and shouldn't be hijacked.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    function onKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta || event.shiftKey || event.altKey) return;
      if (event.key !== "w" && event.key !== "W") return;
      event.preventDefault();
      const { tabs, activeId } = stateRef.current;
      if (tabs.length > 1) {
        closeTab(activeId);
      } else {
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
          getCurrentWindow().close(),
        );
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [closeTab]);

  const selectTab = useCallback(
    (id: string) => {
      const prev = stateRef.current;
      if (prev.activeId === id) return;
      const tab = prev.tabs.find((t) => t.id === id);
      if (!tab) return;
      rememberTabContentScroll(prev.tabs.find((t) => t.id === prev.activeId));
      requestTabContentScrollRestore(tab);
      const target = tabPath(tab);
      flushSync(() => {
        setState({ ...prev, activeId: id });
      });
      void navigate({ href: target });
    },
    [navigate],
  );

  const cycleTab = useCallback(
    (delta: -1 | 1) => {
      const prev = stateRef.current;
      if (prev.tabs.length <= 1) return;
      const idx = prev.tabs.findIndex((t) => t.id === prev.activeId);
      if (idx === -1) return;
      rememberTabContentScroll(prev.tabs[idx]);
      const tab = prev.tabs[(idx + delta + prev.tabs.length) % prev.tabs.length];
      requestTabContentScrollRestore(tab);
      const target = tabPath(tab);
      flushSync(() => {
        setState({ ...prev, activeId: tab.id });
      });
      void navigate({ href: target });
    },
    [navigate],
  );

  // Step the active tab one entry along its private history. We move the
  // cursor immediately (so a rapid second press sees the updated state)
  // but leave `syncedHref` pinned to the *current* href — otherwise
  // the render-phase reconciler fires while the router is still mid-flight
  // on the old href, pushes that old href back onto history, and corrupts
  // the stack so goForward has nothing to walk to. Once `navigate()`
  // completes, href catches up to the new tabPath(active) and the
  // reconciler's "already on this path" branch updates syncedHref cleanly.
  const goBack = useCallback(() => {
    const prev = stateRef.current;
    const tab = prev.tabs.find((t) => t.id === prev.activeId);
    if (!tab || tab.cursor === 0) return;
    const cursor = tab.cursor - 1;
    const target = tab.history[cursor];
    rememberContentScroll(
      tab.id,
      tab.history[tab.cursor],
      currentContentScrollTop(),
    );
    requestContentScrollRestore(tab.id, target);
    const tabs = prev.tabs.map((t) =>
      t.id === tab.id
        ? { ...t, cursor, title: titleFor(t.history[cursor]) }
        : t,
    );
    flushSync(() => {
      setState({ ...prev, tabs });
    });
    void navigate({ href: target });
  }, [navigate]);

  const goForward = useCallback(() => {
    const prev = stateRef.current;
    const tab = prev.tabs.find((t) => t.id === prev.activeId);
    if (!tab || tab.cursor >= tab.history.length - 1) return;
    const cursor = tab.cursor + 1;
    const target = tab.history[cursor];
    rememberContentScroll(
      tab.id,
      tab.history[tab.cursor],
      currentContentScrollTop(),
    );
    requestContentScrollRestore(tab.id, target);
    const tabs = prev.tabs.map((t) =>
      t.id === tab.id
        ? { ...t, cursor, title: titleFor(t.history[cursor]) }
        : t,
    );
    flushSync(() => {
      setState({ ...prev, tabs });
    });
    void navigate({ href: target });
  }, [navigate]);

  const reorderTabs = useCallback((activeId: string, overId: string) => {
    if (activeId === overId) return;
    setState((prev) => {
      const fromIdx = prev.tabs.findIndex((t) => t.id === activeId);
      const toIdx = prev.tabs.findIndex((t) => t.id === overId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev.tabs];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return { ...prev, tabs: next };
    });
  }, []);

  const value = useMemo(
    () => ({
      tabs: state.tabs,
      activeId: state.activeId,
      closeTab,
      newTab,
      openInNewTab,
      selectTab,
      cycleTab,
      reorderTabs,
      goBack,
      goForward,
    }),
    [
      state.tabs,
      state.activeId,
      closeTab,
      newTab,
      openInNewTab,
      selectTab,
      cycleTab,
      reorderTabs,
      goBack,
      goForward,
    ],
  );

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}
