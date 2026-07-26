import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { ListPanel } from "@/components/layout/list-panel";
import {
  PeopleIndexSidebar,
  PersonContextSidebar,
} from "@/components/people/person-context-sidebar";
import { isTauriRuntime } from "@/lib/runtime";

export const Route = createFileRoute("/people")({
  component: PeopleLayout,
});

// The index is a full-width datatable, so its list panel holds a compact
// favorites + recent-activity view instead of duplicating the table. On
// detail pages the panel holds the person's context — Mentioned in, Activity,
// Links — freeing the content column for properties and notes.
function PeopleLayout() {
  const { id } = useParams({ strict: false });
  if (!isTauriRuntime()) return <Outlet />;

  return (
    <>
      <ListPanel>
        {id ? <PersonContextSidebar id={id} /> : <PeopleIndexSidebar />}
      </ListPanel>
      <Outlet />
    </>
  );
}
