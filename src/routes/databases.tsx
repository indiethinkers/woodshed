import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { ListPanel } from "@/components/layout/list-panel";
import {
  DatabasesFavoritesSidebar,
  DatabasesSidebar,
} from "@/components/tables/databases-sidebar";
import { isTauriRuntime } from "@/lib/runtime";

export const Route = createFileRoute("/databases")({
  component: DatabasesLayout,
});

// The index is a full-width datatable, so its list panel holds Favorites
// (starred databases) instead of duplicating the table — matching People,
// Notebook, and Resources. Detail pages (a custom table, a #tag table, a row)
// keep the full Custom + Generated list so it doubles as navigation between
// databases (there's no per-database context panel to show instead).
function DatabasesLayout() {
  const { id, tag, name } = useParams({ strict: false });
  if (!isTauriRuntime()) return <Outlet />;

  const isIndex = !id && !tag && !name;
  return (
    <>
      <ListPanel>
        {isIndex ? <DatabasesFavoritesSidebar /> : <DatabasesSidebar />}
      </ListPanel>
      <Outlet />
    </>
  );
}
