import { createContext, useContext } from "react";

interface ListPanelContextType {
  collapsed: boolean;
  toggle: () => void;
}

export const ListPanelContext = createContext<ListPanelContextType>({
  collapsed: false,
  toggle: () => {},
});

export function useListPanel() {
  return useContext(ListPanelContext);
}
