import { createLazyFileRoute, useParams } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { RowDetail } from "@/components/tables/row-detail";
import { useRow } from "@/lib/hooks/use-tables";

export const Route = createLazyFileRoute("/databases/$id/$rowId")({
  component: RowDetailView,
});

function RowDetailView() {
  const { id, rowId } = useParams({ from: "/databases/$id/$rowId" });
  const { data: row } = useRow(id, rowId);

  return (
    <ContentPanel filePath={row?.path}>
      <RowDetail tableId={id} rowId={rowId} />
    </ContentPanel>
  );
}
