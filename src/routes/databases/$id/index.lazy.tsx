import { createLazyFileRoute, useParams } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { TableView } from "@/components/tables/table-view";
import { useTable } from "@/lib/hooks/use-tables";

export const Route = createLazyFileRoute("/databases/$id/")({
  component: TableViewPage,
});

function TableViewPage() {
  const { id } = useParams({ from: "/databases/$id/" });
  const { data: table } = useTable(id);

  return (
    <ContentPanel wide filePath={table?.path}>
      <TableView tableId={id} />
    </ContentPanel>
  );
}
