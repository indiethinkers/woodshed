import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { ResourceDetail } from "@/components/resources/resource-detail";
import { useResource } from "@/lib/hooks/use-resources";

export const Route = createFileRoute("/resources/$id")({
  component: ResourceView,
});

function ResourceView() {
  const { id } = Route.useParams();
  const { data: resource } = useResource(id);

  return (
    <ContentPanel filePath={resource?.path}>
      <ResourceDetail id={id} />
    </ContentPanel>
  );
}
