import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { AreasList } from "@/components/areas/areas-list";

export const Route = createFileRoute("/areas/")({
  component: AreasIndexPage,
});

function AreasIndexPage() {
  return (
    <ContentPanel wide filePath="areas/">
      <AreasList />
    </ContentPanel>
  );
}
