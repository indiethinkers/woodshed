import { createLazyFileRoute, useParams } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { CustomTableView } from "@/components/tables/custom-table-view";
import { getCustomTable } from "@/lib/data";

export const Route = createLazyFileRoute("/databases/custom/$name")({
  component: CustomTableViewPage,
});

function CustomTableViewPage() {
  const { name } = useParams({ from: "/databases/custom/$name" });
  const table = getCustomTable(name);
  if (!table) {
    return (
      <ContentPanel wide>
        <p className="text-sm text-muted-foreground">Table not found.</p>
      </ContentPanel>
    );
  }

  return (
    <ContentPanel wide>
      <CustomTableView table={table} />
    </ContentPanel>
  );
}
