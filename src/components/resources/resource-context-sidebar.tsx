import { useMemo, useState } from "react";
import { ChronologicalSidebar } from "@/components/shared/chronological-sidebar";
import { ListSidebarPrimaryAction } from "@/components/shared/list-sidebar";
import { RecordContextSidebar } from "@/components/shared/record-context-sidebar";
import { useToday } from "@/lib/hooks/use-today";
import { useAllResources, useResource } from "@/lib/hooks/use-resources";
import { NewResourceForm } from "./new-resource-form";

export function ResourceContextSidebar({ id }: { id: string }) {
  const { data: resource } = useResource(id);
  if (!resource) return null;
  return (
    <RecordContextSidebar
      id={resource.id}
      title={resource.title || "(untitled)"}
      primaryAction={<NewResourceControl />}
    />
  );
}

/** Resources index navigator: favorites pinned above capture-date buckets. */
export function ResourcesIndexSidebar() {
  const today = useToday();
  const { data, isLoading } = useAllResources();

  const items = useMemo(
    () =>
      (data ?? []).map((resource) => ({
        id: resource.id,
        href: `/resources/${resource.id}`,
        title: resource.title || "(untitled)",
        date: resourceCapturedValue(resource),
        preview: resource.source || undefined,
        favorite: resource.favorite,
      })),
    [data],
  );

  return (
    <ChronologicalSidebar
      items={items}
      referenceDate={new Date(`${today}T00:00:00`)}
      isLoading={isLoading}
      emptyMessage="No resources yet. Save one above."
      favoriteEmptyMessage="Star a resource to keep it within reach."
      action={<NewResourceControl />}
    />
  );
}

function NewResourceControl() {
  const [adding, setAdding] = useState(false);

  if (adding) {
    return (
      <div className="mb-5 px-1">
        <NewResourceForm
          onCreated={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      </div>
    );
  }

  return (
    <ListSidebarPrimaryAction
      label="New resource"
      onClick={() => setAdding(true)}
    />
  );
}

/** The same date the table's Saved column uses. */
function resourceCapturedValue(resource: {
  capturedAt?: string | null;
  saved: string;
}): string {
  return resource.capturedAt ?? resource.saved;
}
