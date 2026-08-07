import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  Globe,
  Hash,
  Link2,
  Loader2,
  Newspaper,
  Plus,
} from "lucide-react";
import {
  RecordLinkCell,
  RecordTable,
  useRecordTableState,
  type RecordColumn,
} from "@/components/tables/record-table";
import {
  useAllResources,
  useResourceMutations,
  type ResourceDto,
} from "@/lib/hooks/use-resources";
import type { ViewSort } from "@/lib/hooks/use-tables";
import { NewResourceForm } from "./new-resource-form";
import { ListLoadError } from "@/components/shared/list-load-error";

const DEFAULT_SORTS: ViewSort[] = [{ column: "saved", direction: "desc" }];

const COLUMNS: RecordColumn<ResourceDto>[] = [
  {
    id: "title",
    name: "Title",
    type: "text",
    icon: Newspaper,
    width: 360,
    value: (resource) => resource.title,
    render: (resource, href) => (
      <RecordLinkCell href={href} icon={Newspaper}>
        {resource.title}
      </RecordLinkCell>
    ),
  },
  {
    id: "source",
    name: "Source",
    type: "text",
    icon: Globe,
    width: 220,
    value: (resource) => resource.source,
  },
  {
    id: "tags",
    name: "Tags",
    type: "text",
    icon: Hash,
    width: 260,
    value: (resource) => resource.tags.join(", "),
  },
  {
    id: "saved",
    name: "Saved",
    type: "date",
    icon: CalendarDays,
    width: 170,
    value: resourceCapturedValue,
  },
];

export function ClippingList() {
  const navigate = useNavigate();
  const { data: resources = [], isLoading, isError, refetch } = useAllResources();
  const { capture, update, remove } = useResourceMutations();
  const [adding, setAdding] = useState(false);
  const [captureUrl, setCaptureUrl] = useState("");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const view = useRecordTableState(DEFAULT_SORTS);

  async function commitCapture() {
    const url = captureUrl.trim();
    if (!url || capture.isPending) return;
    setCaptureError(null);
    try {
      const resource = await capture.mutateAsync({ url });
      setCaptureUrl("");
      void navigate({ to: "/resources/$id", params: { id: resource.id } });
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "Capture failed");
    }
  }

  return (
    <RecordTable
      title="Resources"
      unit="resources"
      rows={resources}
      columns={COLUMNS}
      loading={isLoading}
      rowKey={(resource) => resource.id}
      rowHref={(resource) => `/resources/${resource.id}`}
      showViewTab={false}
      totalOnlyWhenUnfiltered
      quietEmptyCells
      searchPlaceholder="Search resources"
      query={view.query}
      onQueryChange={view.setQuery}
      filters={view.filters}
      onFiltersChange={view.setFilters}
      sorts={view.sorts}
      onSortsChange={view.setSorts}
      hasActiveView={view.isDirty}
      onResetView={view.reset}
      onBulkDelete={(targets) =>
        Promise.all(targets.map((resource) => remove.mutateAsync({ id: resource.id })))
      }
      favorite={{
        isFavorite: (resource) => resource.favorite,
        onToggle: (resource) =>
          update.mutate({
            id: resource.id,
            update: { favorite: !resource.favorite },
          }),
      }}
      emptyMessage="No resources yet — capture a URL above to save one."
      errorState={
        isError && resources.length === 0 ? (
          <ListLoadError surface="resources" onRetry={() => void refetch()} />
        ) : undefined
      }
      action={
        !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label="New resource"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <Plus className="h-4 w-4" strokeWidth={1.7} />
          </button>
        )
      }
      controlsEnd={
        <div
          className="flex items-center gap-1.5"
          onKeyDown={(event) => {
            if (
              event.key.length === 1 ||
              event.key === "Enter" ||
              event.key === "Escape"
            ) {
              event.stopPropagation();
            }
          }}
        >
          <input
            type="url"
            value={captureUrl}
            onChange={(event) => setCaptureUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitCapture();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setCaptureUrl("");
                setCaptureError(null);
              }
            }}
            placeholder="Capture URL"
            className="h-8 w-64 min-w-0 rounded-md border border-border/70 bg-background/50 px-2.5 font-mono text-[12px] outline-none placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-[var(--focus-ring)]"
          />
          <button
            type="button"
            onClick={() => void commitCapture()}
            disabled={capture.isPending || !captureUrl.trim()}
            aria-label="Capture URL"
            title="Capture URL"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground transition-colors hover:bg-accent/80 disabled:opacity-50"
          >
            {capture.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Link2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      }
      aboveGrid={
        (captureError || adding) && (
          <div className="mb-4">
            {captureError && (
              <p className="mb-2 text-[11px] leading-4 text-destructive">
                {captureError}
              </p>
            )}
            {adding && (
              <div className="max-w-md border-b border-border pb-6">
                <NewResourceForm
                  onCreated={() => setAdding(false)}
                  onCancel={() => setAdding(false)}
                />
              </div>
            )}
          </div>
        )
      }
    />
  );
}

function resourceCapturedValue(resource: ResourceDto): string {
  return resource.capturedAt ?? resource.saved;
}
