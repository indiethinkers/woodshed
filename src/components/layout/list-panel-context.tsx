import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ListPanelContext } from "./list-panel-context-internal";

export function ListPanelProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const toggle = useCallback(() => setCollapsed((current) => !current), []);
  const value = useMemo(() => ({ collapsed, toggle }), [collapsed, toggle]);

  return (
    <ListPanelContext.Provider value={value}>
      {children}
    </ListPanelContext.Provider>
  );
}
