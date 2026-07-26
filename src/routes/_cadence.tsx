import { createFileRoute, Outlet } from "@tanstack/react-router";
import { TaskSidebar } from "@/components/cadence/task-sidebar";
import { SidebarSchedule } from "@/components/cadence/schedule-block";
import { ListPanel } from "@/components/layout/list-panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isTauriRuntime } from "@/lib/runtime";

// Pathless layout shared by the daily page, dated daily pages, and event
// detail routes. Underscore prefix tells TanStack file routing to wrap
// children without adding a URL segment — same role the (cadence) route
// group played in the Next app router.
export const Route = createFileRoute("/_cadence")({
  component: CadenceLayout,
});

function CadenceLayout() {
  if (!isTauriRuntime()) return <Outlet />;

  return (
    <>
      {/* The schedule is pinned to the bottom of the panel; the task list
          takes the remaining height and scrolls under it on busy days. */}
      <ListPanel scrollable={false}>
        <ScrollArea className="min-h-0 flex-1">
          <TaskSidebar />
        </ScrollArea>
        <SidebarSchedule />
      </ListPanel>
      <Outlet />
    </>
  );
}
