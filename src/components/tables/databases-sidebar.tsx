import { useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { CalendarDays, Hash, Table2 } from "lucide-react";
import {
  ListSidebar,
  ListSidebarEmpty,
  ListSidebarPrimaryAction,
  ListSidebarRow,
  ListSidebarSection,
} from "@/components/shared/list-sidebar";
import {
  FavoritesSidebar,
  type FavoriteItem,
} from "@/components/shared/favorites-sidebar";
import {
  useAllTables,
  useDatabaseTagFavorites,
  useTableMutations,
} from "@/lib/hooks/use-tables";
import { useTagsWithCounts } from "@/lib/hooks/use-tag-table";

const ICON_CLASS = "h-3.5 w-3.5 text-muted-foreground";

// Databases list panel: custom tables, then the auto-generated tag tables —
// the compact companion to the full-width index datatable.
export function DatabasesSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: customTables = [] } = useAllTables();
  const { data: generatedTables = [] } = useTagsWithCounts();

  const sortedGenerated = useMemo(
    () =>
      [...generatedTables].sort((a, b) => {
        if (a.tag === "event") return -1;
        if (b.tag === "event") return 1;
        return b.count - a.count || a.tag.localeCompare(b.tag);
      }),
    [generatedTables],
  );

  const total = customTables.length + generatedTables.length;

  return (
    <ListSidebar>
      <DatabaseSidebarCreateControl />
      {total === 0 ? (
        <ListSidebarEmpty>No databases yet.</ListSidebarEmpty>
      ) : (
        <>
          {customTables.length > 0 && (
            <ListSidebarSection label="Custom" count={customTables.length}>
              {customTables.map((table) => {
                const href = `/databases/${table.id}`;
                return (
                  <ListSidebarRow
                    key={table.id}
                    href={href}
                    active={pathname === href}
                    title={table.name}
                    trailing={table.rowCount.toLocaleString()}
                    leading={
                      <Table2
                        className="h-3.5 w-3.5 text-muted-foreground"
                        strokeWidth={1.8}
                      />
                    }
                  />
                );
              })}
            </ListSidebarSection>
          )}
          {sortedGenerated.length > 0 && (
            <ListSidebarSection
              label="Generated"
              count={sortedGenerated.length}
            >
              {sortedGenerated.map((row) => {
                const href = `/databases/tags/${encodeURIComponent(row.tag)}`;
                const Icon = row.tag === "event" ? CalendarDays : Hash;
                return (
                  <ListSidebarRow
                    key={row.tag}
                    href={href}
                    active={pathname === href}
                    title={`#${row.tag}`}
                    trailing={row.count.toLocaleString()}
                    leading={
                      <Icon
                        className="h-3.5 w-3.5 text-muted-foreground"
                        strokeWidth={1.8}
                      />
                    }
                  />
                );
              })}
            </ListSidebarSection>
          )}
        </>
      )}
    </ListSidebar>
  );
}

/**
 * Databases index list panel: starred databases (custom tables + generated
 * `#tag` tables). Mirrors the Favorites panel on People / Notebook /
 * Resources — the full list lives in the index datatable, so the panel holds
 * only the short, starred set.
 */
export function DatabasesFavoritesSidebar() {
  const { data: customTables = [] } = useAllTables();
  const { data: generatedTables = [] } = useTagsWithCounts();
  const { data: tagFavorites = [] } = useDatabaseTagFavorites();
  const tagFavoriteSet = useMemo(() => new Set(tagFavorites), [tagFavorites]);

  const items = useMemo<FavoriteItem[]>(() => {
    const custom: FavoriteItem[] = customTables
      .filter((table) => table.favorite)
      .map((table) => ({
        id: table.id,
        href: `/databases/${table.id}`,
        title: table.name,
        meta: `${table.rowCount.toLocaleString()} rows`,
        leading: <Table2 className={ICON_CLASS} strokeWidth={1.8} />,
      }));
    const generated: FavoriteItem[] = generatedTables
      .filter((row) => tagFavoriteSet.has(`tag:${row.tag}`))
      .map((row) => {
        const Icon = row.tag === "event" ? CalendarDays : Hash;
        return {
          id: `tag:${row.tag}`,
          href: `/databases/tags/${encodeURIComponent(row.tag)}`,
          title: `#${row.tag}`,
          meta: `${row.count.toLocaleString()} rows`,
          leading: <Icon className={ICON_CLASS} strokeWidth={1.8} />,
        };
      });
    return [...custom, ...generated];
  }, [customTables, generatedTables, tagFavoriteSet]);

  return (
    <FavoritesSidebar
      items={items}
      primaryAction={<DatabaseSidebarCreateControl />}
    />
  );
}

function DatabaseSidebarCreateControl() {
  const navigate = useNavigate();
  const { create } = useTableMutations();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  async function commit() {
    const trimmed = name.trim();
    if (!trimmed || create.isPending) return;
    const database = await create.mutateAsync({ name: trimmed });
    setCreating(false);
    setName("");
    void navigate({ to: "/databases/$id", params: { id: database.id } });
  }

  if (!creating) {
    return (
      <ListSidebarPrimaryAction
        label="New database"
        onClick={() => setCreating(true)}
      />
    );
  }

  return (
    <div
      className="mb-5 space-y-2 rounded-md border border-border bg-background/50 p-3"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        New database
      </p>
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setCreating(false);
            setName("");
          }
        }}
        placeholder="Database name"
        className="h-8 w-full rounded-sm border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      <div className="flex items-center justify-end gap-1.5 pt-1">
        <button
          type="button"
          onClick={() => {
            setCreating(false);
            setName("");
          }}
          disabled={create.isPending}
          className="h-7 rounded-sm px-3 text-[13px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void commit()}
          disabled={create.isPending || !name.trim()}
          className="h-7 rounded-sm bg-accent px-3 text-[13px] text-accent-foreground disabled:opacity-50"
        >
          {create.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
