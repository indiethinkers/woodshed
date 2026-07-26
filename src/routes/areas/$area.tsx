import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { SpaceView } from "@/components/areas/area-view";
import { UNASSIGNED_AREA_ID } from "@/lib/areas";
import { useAreas } from "@/lib/hooks/use-areas";
import type { AreaId } from "@/lib/types";

export const Route = createFileRoute("/areas/$area")({
  component: AreaViewPage,
});

function AreaViewPage() {
  const { area } = Route.useParams();
  // Validate against the live area list rather than a hardcoded
  // whitelist — users can create areas at runtime via areas_create,
  // and the previous static list excluded Acme plus anything the
  // user added themselves. While the list is loading, render the view
  // optimistically; the data layer falls back to seeded defaults for
  // tests / no-Tauri environments.
  const { data: areas, isLoading } = useAreas();

  const isUnassigned = area === UNASSIGNED_AREA_ID;
  const notFound =
    !isUnassigned && !isLoading && areas && !areas.some((a) => a.id === area);
  if (notFound) {
    return (
      <ContentPanel>
        <p className="text-sm text-muted-foreground">Area not found.</p>
      </ContentPanel>
    );
  }

  return (
    <ContentPanel
      wide
      filePath={isUnassigned ? "area: unassigned" : `areas/${area}.md`}
    >
      <SpaceView area={area as AreaId} />
    </ContentPanel>
  );
}
