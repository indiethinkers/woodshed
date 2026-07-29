import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ListPanelContext } from "./list-panel-context-internal";
import { tabPath, useTabs } from "./tabs-context-internal";

type ListPanelViewType = "database" | "record" | "other";

interface TabPanelState {
  viewType: ListPanelViewType;
  override?: boolean;
}

export function ListPanelProvider({ children }: { children: ReactNode }) {
  const { tabs, activeId } = useTabs();
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const viewType = listPanelViewType(activeTab ? tabPath(activeTab) : "/");
  const [tabStates, setTabStates] = useState<Record<string, TabPanelState>>({});
  const activeState = activeId ? tabStates[activeId] : undefined;
  const stateMatchesView = activeState?.viewType === viewType;
  const staleViewType = activeState?.viewType;

  useEffect(() => {
    if (!activeId || !staleViewType || staleViewType === viewType) return;
    setTabStates((current) => {
      if (current[activeId]?.viewType !== staleViewType) return current;
      const next = { ...current };
      delete next[activeId];
      return next;
    });
  }, [activeId, staleViewType, viewType]);

  const collapsed =
    (stateMatchesView ? activeState.override : undefined) ?? false;
  const toggle = useCallback(() => {
    if (!activeId) return;
    setTabStates((current) => ({
      ...current,
      [activeId]: { viewType, override: !collapsed },
    }));
  }, [activeId, collapsed, viewType]);
  const value = useMemo(() => ({ collapsed, toggle }), [collapsed, toggle]);

  return (
    <ListPanelContext.Provider value={value}>
      {children}
    </ListPanelContext.Provider>
  );
}

function listPanelViewType(href: string): ListPanelViewType {
  const pathname = href.split(/[?#]/, 1)[0].replace(/\/$/, "") || "/";
  if (pathname === "/notebook" || pathname === "/resources") {
    return "database";
  }
  if (/^\/(?:notebook|resources)\/[^/]+$/.test(pathname)) {
    return "record";
  }
  return "other";
}
