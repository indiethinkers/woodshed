import { createContext, useContext } from "react";

export interface RightSidebarEntry {
  id: string;
  href: string;
  title: string;
  expanded: boolean;
  addedAt: number;
}

export interface RightSidebarTarget {
  href: string;
  title?: string;
}

interface RightSidebarContextType {
  open: boolean;
  entries: RightSidebarEntry[];
  addPage: (target: RightSidebarTarget) => void;
  closeSidebar: () => void;
  openSidebar: () => void;
  removePage: (id: string) => void;
  toggleEntry: (id: string) => void;
  toggleSidebar: () => void;
}

export const RightSidebarContext = createContext<RightSidebarContextType>({
  open: false,
  entries: [],
  addPage: () => {},
  closeSidebar: () => {},
  openSidebar: () => {},
  removePage: () => {},
  toggleEntry: () => {},
  toggleSidebar: () => {},
});

export function useRightSidebar() {
  return useContext(RightSidebarContext);
}
