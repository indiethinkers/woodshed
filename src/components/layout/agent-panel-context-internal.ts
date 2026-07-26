import { createContext, useContext } from "react";

interface AgentPanelContextType {
  open: boolean;
  close: () => void;
  toggle: () => void;
}

export const AgentPanelContext = createContext<AgentPanelContextType>({
  open: false,
  close: () => {},
  toggle: () => {},
});

export function useAgentPanel() {
  return useContext(AgentPanelContext);
}
