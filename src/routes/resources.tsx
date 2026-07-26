import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { ListPanel } from "@/components/layout/list-panel";
import {
  ResourceContextSidebar,
  ResourcesIndexSidebar,
} from "@/components/resources/resource-context-sidebar";
import { isTauriRuntime } from "@/lib/runtime";

export const Route = createFileRoute("/resources")({
  component: ResourcesLayout,
});

// The index pairs its full datatable with a compact navigator: favorites
// pinned first, then the old capture-date buckets. Detail pages keep their
// graph context (Links and Backlinks) in this panel.
function ResourcesLayout() {
  const { id } = useParams({ strict: false });
  if (!isTauriRuntime()) return <Outlet />;

  return (
    <>
      <ListPanel>
        {id ? <ResourceContextSidebar id={id} /> : <ResourcesIndexSidebar />}
      </ListPanel>
      <Outlet />
    </>
  );
}
