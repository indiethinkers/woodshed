import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import {
  AreasRecentSidebar,
  AreasSidebar,
} from "@/components/areas/areas-sidebar";
import { ListPanel } from "@/components/layout/list-panel";
import { isTauriRuntime } from "@/lib/runtime";

export const Route = createFileRoute("/areas")({
  component: AreasLayout,
});

// The index's content panel is the full area table, so its list panel holds
// the cross-area Recent feed instead of duplicating the list. On a specific
// area's page the panel reverts to the area switcher so you can jump between
// areas while reading one.
function AreasLayout() {
  const { area } = useParams({ strict: false });
  if (!isTauriRuntime()) return <Outlet />;

  return (
    <>
      <ListPanel>
        {area ? <AreasSidebar /> : <AreasRecentSidebar />}
      </ListPanel>
      <Outlet />
    </>
  );
}
