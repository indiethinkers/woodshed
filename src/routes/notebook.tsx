import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { ListPanel } from "@/components/layout/list-panel";
import {
  NoteContextSidebar,
  NotebookIndexSidebar,
} from "@/components/notebook/note-context-sidebar";
import { isTauriRuntime } from "@/lib/runtime";

export const Route = createFileRoute("/notebook")({
  component: NotebookLayout,
});

// The index pairs its full datatable with a compact navigator: favorites
// pinned first, then the old chronological note buckets. Detail pages keep
// their graph context (Links and Backlinks) in this panel.
function NotebookLayout() {
  const { id } = useParams({ strict: false });
  if (!isTauriRuntime()) return <Outlet />;

  return (
    <>
      <ListPanel>
        {id ? <NoteContextSidebar id={id} /> : <NotebookIndexSidebar />}
      </ListPanel>
      <Outlet />
    </>
  );
}
