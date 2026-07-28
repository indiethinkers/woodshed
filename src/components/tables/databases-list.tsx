import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CalendarDays, Database, Plus, Rows3 } from "lucide-react";
import {
  RecordLinkCell,
  RecordTable,
  useRecordTableState,
  type RecordColumn,
} from "@/components/tables/record-table";
import { FilePathLine } from "@/components/shared/file-path-pill";
import {
  useAllTables,
  useDatabaseFavoriteMutations,
  useDatabaseTagFavorites,
  useTableMutations,
  type ViewSort,
} from "@/lib/hooks/use-tables";
import { useTagsWithCounts } from "@/lib/hooks/use-tag-table";

// Shared row projection for two separate inline databases: user-created
// tables under `tables/`, and read-only views generated from `#tags`.
interface DatabaseRowItem {
  id: string;
  name: string;
  rows: number;
  /** Custom tables only — generated tag tables have no creation date. */
  created: string | null;
  href: string;
  favorite: boolean;
  tag?: string;
}

const DEFAULT_SORTS: ViewSort[] = [{ column: "rows", direction: "desc" }];

const NAME_COLUMN: RecordColumn<DatabaseRowItem> = {
  id: "name",
  name: "Name",
  type: "text",
  icon: Database,
  width: 480,
  value: (row) => row.name,
  render: (row, href) => (
    <RecordLinkCell href={href}>{row.name}</RecordLinkCell>
  ),
};

const ROWS_COLUMN: RecordColumn<DatabaseRowItem> = {
  id: "rows",
  name: "Rows",
  type: "number",
  icon: Rows3,
  width: 140,
  value: (row) => row.rows,
};

const CUSTOM_COLUMNS: RecordColumn<DatabaseRowItem>[] = [
  NAME_COLUMN,
  ROWS_COLUMN,
  {
    id: "created",
    name: "Created",
    type: "date",
    icon: CalendarDays,
    width: 190,
    value: (row) => row.created,
  },
];

const GENERATED_COLUMNS: RecordColumn<DatabaseRowItem>[] = [
  NAME_COLUMN,
  ROWS_COLUMN,
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
  const customView = useRecordTableState(DEFAULT_SORTS);
  const generatedView = useRecordTableState(DEFAULT_SORTS);

  const tagFavoriteSet = useMemo(() => new Set(tagFavorites), [tagFavorites]);

  const customRows = useMemo<DatabaseRowItem[]>(
    () =>
      customTables.map((table) => ({
        id: table.id,
        name: table.name,
        rows: table.rowCount,
        created: table.created,
        href: `/databases/${table.id}`,
        favorite: table.favorite,
      })),
    [customTables],
  );

  const generatedRows = useMemo<DatabaseRowItem[]>(
    () =>
      generatedTables.map((row) => ({
        id: `tag:${row.tag}`,
        name: `#${row.tag}`,
        rows: row.count,
        created: null,
        href: `/databases/tags/${encodeURIComponent(row.tag)}`,
        favorite: tagFavoriteSet.has(`tag:${row.tag}`),
        tag: row.tag,
      })),
    [generatedTables, tagFavoriteSet],
  );
  const totalCount = customRows.length + generatedRows.length;

  async function commitCreate() {
    const name = draft.trim();
    if (!name || create.isPending) return;
    const created = await create.mutateAsync({ name });
    setCreating(false);
    setDraft("");
    void navigate({ to: "/databases/$id", params: { id: created.id } });
  }

  return (
    <div className="w-full pb-24">
      <header className="mb-9 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="min-w-0 text-[32px] font-bold leading-tight tracking-normal text-foreground">
            Databases
          </h1>
          <FilePathLine className="mt-1.5" />
        </div>
        <span className="mt-2 font-mono text-[12px] tabular-nums text-muted-foreground">
          {totalCount} {totalCount === 1 ? "database" : "databases"}
        </span>
      </header>

      <div className="space-y-12">
        <RecordTable
          variant="inline"
          title="Custom"
          unit="databases"
          rows={customRows}
          columns={CUSTOM_COLUMNS}
          loading={isLoading}
          rowKey={(row) => row.id}
          rowHref={(row) => row.href}
          showViewTab={false}
          totalOnlyWhenUnfiltered
          favorite={{
            isFavorite: (row) => row.favorite,
            onToggle: (row) => {
              setTableFavorite.mutate({
                id: row.id,
                favorite: !row.favorite,
              });
            },
          }}
          searchPlaceholder="Search custom databases"
          query={customView.query}
          onQueryChange={customView.setQuery}
          filters={customView.filters}
          onFiltersChange={customView.setFilters}
          sorts={customView.sorts}
          onSortsChange={customView.setSorts}
          hasActiveView={customView.isDirty}
          onResetView={customView.reset}
          emptyMessage="No custom databases yet. Click + to create one."
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

        <RecordTable
          variant="inline"
          title="Generated"
          unit="databases"
          rows={generatedRows}
          columns={GENERATED_COLUMNS}
          loading={isLoadingGenerated}
          rowKey={(row) => row.id}
          rowHref={(row) => row.href}
          showViewTab={false}
          totalOnlyWhenUnfiltered
          favorite={{
            isFavorite: (row) => row.favorite,
            onToggle: (row) => {
              if (row.tag) {
                setTagFavorite.mutate({
                  tag: row.tag,
                  favorite: !row.favorite,
                });
              }
            },
          }}
          searchPlaceholder="Search generated databases"
          query={generatedView.query}
          onQueryChange={generatedView.setQuery}
          filters={generatedView.filters}
          onFiltersChange={generatedView.setFilters}
          sorts={generatedView.sorts}
          onSortsChange={generatedView.setSorts}
          hasActiveView={generatedView.isDirty}
          onResetView={generatedView.reset}
          emptyMessage="No generated databases yet. Add a #tag to any record to create one."
        />
      </div>
    </div>
  );
}
