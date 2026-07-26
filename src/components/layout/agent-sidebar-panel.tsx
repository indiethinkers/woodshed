import { useRouterState } from "@tanstack/react-router";
import { AgentSurface } from "@/components/agent/agent-surface";
import { useResolvedRouteTitle } from "@/lib/route-title";
import { isTauriRuntime } from "@/lib/runtime";
import { cn } from "@/lib/utils";
import { useAgentPanel } from "./agent-panel-context-internal";
import { canShowAgentPanel, isAgentFocusMode } from "./agent-panel-route";
import { useListPanel } from "./list-panel-context-internal";

export function AgentSidebarPanel() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { open } = useAgentPanel();
  const { collapsed } = useListPanel();
  const title = useResolvedRouteTitle(pathname, fallbackTitle(pathname));
  const focusMode = isAgentFocusMode(pathname, open);

  if (!isTauriRuntime() || !canShowAgentPanel(pathname)) return null;

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "h-full shrink-0 overflow-hidden border-r border-border bg-list",
        focusMode ? "w-[352px]" : "w-[300px]",
        (!open || collapsed) && "hidden",
      )}
      data-woodshed-surface="agent-sidebar"
    >
      <AgentSurface
        contextTitle={title}
        contextPathname={pathname}
        variant="sidebar"
      />
    </aside>
  );
}

function fallbackTitle(pathname: string): string {
  if (pathname === "/") return "Cadence";
  const segment = pathname.split("/").filter(Boolean).at(-1) ?? "Woodshed";
  return segment
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
