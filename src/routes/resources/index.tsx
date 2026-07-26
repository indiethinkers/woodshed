import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { ClippingList } from "@/components/resources/clipping-list";

export const Route = createFileRoute("/resources/")({
  component: ResourcesIndexPage,
});

function ResourcesIndexPage() {
  return (
    <ContentPanel wide filePath="resources/">
      <ClippingList />
    </ContentPanel>
  );
}
