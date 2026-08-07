import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  RightSidebarContext,
  type RightSidebarEntry,
  type RightSidebarTarget,
} from "./right-sidebar-context-internal";
import { isEditableElement } from "@/lib/dom/is-editable";
import { isRightSidebarToggleShortcut } from "./right-sidebar-shortcut";

const MAX_REFERENCE_PAGES = 12;

export function RightSidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<RightSidebarEntry[]>([]);

  const addPage = useCallback((target: RightSidebarTarget) => {
    const href = normalizeReferenceHref(target.href);
    if (!href) return;
    const title = target.title?.trim() || titleFromHref(href);

    setEntries((current) => {
      const existing = current.find((entry) => entry.href === href);
      const rest = current.filter((entry) => entry.href !== href);
      const next: RightSidebarEntry = existing
        ? {
            ...existing,
            title: target.title?.trim() || existing.title,
            expanded: true,
          }
        : {
            id: href,
            href,
            title,
            expanded: true,
            addedAt: Date.now(),
          };
      return [next, ...rest].slice(0, MAX_REFERENCE_PAGES);
    });
    setOpen(true);
  }, []);

  const closeSidebar = useCallback(() => setOpen(false), []);
  const openSidebar = useCallback(() => setOpen(true), []);
  const toggleSidebar = useCallback(() => setOpen((current) => !current), []);

  const removePage = useCallback(
    (id: string) => {
      // Closing the only open reference doc collapses the sidebar too — but
      // not the toggle-opened empty panel, which the user opens deliberately
      // to add pages.
      const wasLast = entries.length === 1 && entries[0]?.id === id;
      setEntries((current) => current.filter((entry) => entry.id !== id));
      if (wasLast) setOpen(false);
    },
    [entries],
  );

  const toggleEntry = useCallback((id: string) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.id === id ? { ...entry, expanded: !entry.expanded } : entry,
      ),
    );
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isRightSidebarToggleShortcut(event)) return;
      if (isEditableElement(event.target)) return;
      event.preventDefault();
      setOpen((current) => !current);
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.button !== 0 || !event.shiftKey) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented) return;

      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a");
      if (!anchor) return;
      if (anchor.target === "_blank") return;

      const href = anchor.getAttribute("href");
      if (!href || !href.startsWith("/")) return;

      event.preventDefault();
      event.stopPropagation();
      addPage({
        href,
        title: anchor.textContent?.trim() || undefined,
      });
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [addPage]);

  const value = useMemo(
    () => ({
      open,
      entries,
      addPage,
      closeSidebar,
      openSidebar,
      removePage,
      toggleEntry,
      toggleSidebar,
    }),
    [
      open,
      entries,
      addPage,
      closeSidebar,
      openSidebar,
      removePage,
      toggleEntry,
      toggleSidebar,
    ],
  );

  return (
    <RightSidebarContext.Provider value={value}>
      {children}
    </RightSidebarContext.Provider>
  );
}

function normalizeReferenceHref(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  try {
    const base =
      typeof window === "undefined" ? "http://woodshed.local" : window.location.origin;
    const url = new URL(trimmed, base);
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }
}

function titleFromHref(href: string): string {
  if (href === "/") return "Today";
  const path = href.split(/[?#]/)[0] ?? href;
  const leaf = path.split("/").filter(Boolean).at(-1) ?? "Page";
  return leaf
    .replace(/\.md$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
