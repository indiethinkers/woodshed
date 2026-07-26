import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { AgentPanelContext } from "./agent-panel-context-internal";

export function AgentPanelProvider({ children }: { children: ReactNode }) {
  // The agent panel toggle is page-specific: opening it on one page doesn't
  // open it elsewhere. We key open state by pathname so navigating away and
  // back restores whatever the panel was on that page.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [openByPath, setOpenByPath] = useState<Record<string, boolean>>({});
  const open = openByPath[pathname] ?? false;

  const close = useCallback(() => {
    setOpenByPath((current) => ({ ...current, [pathname]: false }));
  }, [pathname]);

  const toggle = useCallback(() => {
    setOpenByPath((current) => ({
      ...current,
      [pathname]: !(current[pathname] ?? false),
    }));
  }, [pathname]);

  const value = useMemo(() => ({ open, close, toggle }), [open, close, toggle]);

  return (
    <AgentPanelContext.Provider value={value}>
      {children}
    </AgentPanelContext.Provider>
  );
}
