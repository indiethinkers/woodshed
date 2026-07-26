import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { DatabasesList } from "@/components/tables/databases-list";

export const Route = createFileRoute("/databases/")({
  component: DatabasesIndexPage,
});

function DatabasesIndexPage() {
  return (
    <ContentPanel wide filePath="tables/">
      <DatabasesList />
    </ContentPanel>
  );
}
