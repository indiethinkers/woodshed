import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  Database,
  Plus,
  Rows3,
} from "lucide-react";
import {
  RecordLinkCell,
  RecordTable,
  useRecordTableState,
  type RecordColumn,
} from "@/components/tables/record-table";
import {
  useAllTables,
  useDatabaseFavoriteMutations,
  useDatabaseTagFavorites,
  useTableMutations,
  type ViewSort,
} from "@/lib/hooks/use-tables";
import { useTagsWithCounts } from "@/lib/hooks/use-tag-table";

// Unified row over the two database kinds: user-created tables under
// `tables/` and the auto-generated `#tag` tables. One RecordTable so the
// index gets the same search / filter / sort treatment as Notebook,
// People, and Resources.
interface DatabaseRowItem {
  id: string;
  name: string;
  kind: "Custom" | "Generated";
  rows: number;
  /** Custom tables only — generated tag tables have no creation date. */
  created: string | null;
  href: string;
  favorite: boolean;
  tag?: string;
}

const DEFAULT_SORTS: ViewSort[] = [{ column: "rows", direction: "desc" }];

const COLUMNS: RecordColumn<DatabaseRowItem>[] = [
  {
    id: "name",
    name: "Name",
    type: "text",
    icon: Database,
    width: 480,
    value: (row) => row.name,
    render: (row, href) => (
      <RecordLinkCell href={href}>{row.name}</RecordLinkCell>
    ),
  },
  {
    id: "rows",
    name: "Rows",
    type: "number",
    icon: Rows3,
    width: 140,
    value: (row) => row.rows,
  },
  {
    id: "created",
    name: "Created",
    type: "date",
    icon: CalendarDays,
    width: 190,
    value: (row) => row.created,
  },
];

export function DatabasesList() {
  const navigate = useNavigate();
  const { data: customTables = [], isLoading } = useAllTables();
  const { data: generatedTables = [], isLoading: isLoadingGenerated } =
    useTagsWithCounts();
  const { data: tagFavorites = [] } = useDatabaseTagFavorites();
  const { create } = useTableMutations();
  const { setTableFavorite, setTagFavorite } = useDatabaseFavoriteMutations();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const view = useRecordTableState(DEFAULT_SORTS);

  const tagFavoriteSet = useMemo(() => new Set(tagFavorites), [tagFavorites]);

  const rows = useMemo<DatabaseRowItem[]>(
    () => [
      ...customTables.map((table) => ({
        id: table.id,
        name: table.name,
        kind: "Custom" as const,
        rows: table.rowCount,
        created: table.created,
        href: `/databases/${table.id}`,
        favorite: table.favorite,
      })),
      ...generatedTables.map((row) => ({
        id: `tag:${row.tag}`,
        name: `#${row.tag}`,
        kind: "Generated" as const,
        rows: row.count,
        created: null,
        href: `/databases/tags/${encodeURIComponent(row.tag)}`,
        favorite: tagFavoriteSet.has(`tag:${row.tag}`),
        tag: row.tag,
      })),
    ],
    [customTables, generatedTables, tagFavoriteSet],
  );

  async function commitCreate() {
    const name = draft.trim();
    if (!name || create.isPending) return;
    const created = await create.mutateAsync({ name });
    setCreating(false);
    setDraft("");
    void navigate({ to: "/databases/$id", params: { id: created.id } });
  }

  return (
    <RecordTable
      title="Databases"
      unit="databases"
      rows={rows}
      columns={COLUMNS}
      loading={isLoading || isLoadingGenerated}
      rowKey={(row) => row.id}
      rowHref={(row) => row.href}
      groupBy={(row) => row.kind}
      groupOrder={["Custom", "Generated"]}
      showViewTab={false}
      totalOnlyWhenUnfiltered
      favorite={{
        isFavorite: (row) => row.favorite,
        onToggle: (row) => {
          if (row.kind === "Custom") {
            setTableFavorite.mutate({ id: row.id, favorite: !row.favorite });
          } else if (row.tag) {
            setTagFavorite.mutate({ tag: row.tag, favorite: !row.favorite });
          }
        },
      }}
      searchPlaceholder="Search databases"
      query={view.query}
      onQueryChange={view.setQuery}
      filters={view.filters}
      onFiltersChange={view.setFilters}
      sorts={view.sorts}
      onSortsChange={view.setSorts}
      hasActiveView={view.isDirty}
      onResetView={view.reset}
      emptyMessage="No databases yet. Click + to create one, or add a #tag to any record to generate one."
      action={
        !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            aria-label="New database"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <Plus className="h-4 w-4" strokeWidth={1.7} />
          </button>
        )
      }
      aboveGrid={
        creating && (
          <div className="mb-4 max-w-sm">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (!draft.trim()) {
                  setCreating(false);
                  setDraft("");
                } else {
                  void commitCreate();
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitCreate();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setCreating(false);
                  setDraft("");
                }
              }}
              placeholder="Database name"
              className="h-9 w-full rounded-md border border-border/70 bg-background/50 px-3 text-sm outline-none placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-[var(--focus-ring)]"
            />
          </div>
        )
      }
    />
  );
}
