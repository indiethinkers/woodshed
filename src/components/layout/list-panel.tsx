import { ScrollArea } from "@/components/ui/scroll-area";
import { useRouterState } from "@tanstack/react-router";
import { isTauriRuntime } from "@/lib/runtime";
import { useAgentPanel } from "./agent-panel-context-internal";
import { canShowAgentPanel } from "./agent-panel-route";
import { useListPanel } from "./list-panel-context-internal";

export function ListPanel({
  children,
  className,
  scrollable = true,
}: {
  children?: React.ReactNode;
  className?: string;
  /** When false, the panel renders children in a full-height flex column and
   *  the caller owns scrolling — used by Cadence to scroll the task list while
   *  pinning the schedule to the bottom. */
  scrollable?: boolean;
}) {
  const { collapsed } = useListPanel();
  const { open: agentOpen } = useAgentPanel();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (
    !isTauriRuntime() ||
    collapsed ||
    (agentOpen && canShowAgentPanel(pathname))
  ) {
    return null;
  }

  return (
    <div
      data-woodshed-surface="list-panel"
      className={`h-full w-[300px] shrink-0 border-r border-border ${
        className ?? "bg-list"
      }`}
    >
      {scrollable ? (
        <ScrollArea className="h-full min-h-0">{children}</ScrollArea>
      ) : (
        <div className="flex h-full min-h-0 flex-col">{children}</div>
      )}
    </div>
  );
}
