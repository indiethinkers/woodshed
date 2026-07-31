"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";

export type ColumnType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "checkbox"
  | "date";
export type SortDirection = "asc" | "desc";
export type CalcFn = "sum" | "count" | "avg" | "min" | "max";
export type FilterCombineOp = "and" | "or";
export type ViewType = "table" | "board" | "calendar" | "gallery" | "list";

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

export type NumberFormat =
  | "number"
  | "us_dollar"
  | "euro"
  | "british_pound"
  | "japanese_yen"
  | "percent";

export interface ColumnDto {
  id: string;
  name: string;
  type: ColumnType;
  options?: SelectOption[];
  /** Pixel width set by the user via the resize handle. Undefined → use the
   *  per-position default (wider for the title column, narrower elsewhere). */
  width?: number;
  /** Display format for Number columns. Ignored for other types. */
  format?: NumberFormat;
  /** Decimal places for number rendering. Undefined → format default. */
  precision?: number;
}

export interface ViewSort {
  column: string;
  direction: SortDirection;
}

export interface ViewFilter {
  column: string;
  op: string;
  value?: unknown;
}

export interface ViewFilters {
  op: FilterCombineOp;
  conditions: ViewFilter[];
}

export interface ViewDto {
  id: string;
  name: string;
  type: ViewType;
  sorts?: ViewSort[];
  filters?: ViewFilters;
  hidden?: string[];
  calculations?: Record<string, CalcFn>;
  group_by?: string | null;
}

export interface TableDto {
  id: string;
  path: string;
  name: string;
  created: string;
  favorite: boolean;
  columns: ColumnDto[];
  views: ViewDto[];
}

export interface TableMeta {
  id: string;
  name: string;
  created: string;
  favorite: boolean;
  rowCount: number;
}

export type CellValue = string | number | boolean | string[] | null;

export interface RowDto {
  id: string;
  path: string;
  table: string;
  created: string;
  sortKey?: number | null;
  cells: Record<string, CellValue>;
  body: string;
}

export interface TableCreateInput {
  name: string;
  columns?: ColumnDto[];
  views?: ViewDto[];
}

export interface TableUpdateInput {
  name?: string;
  columns?: ColumnDto[];
  views?: ViewDto[];
  favorite?: boolean;
}

export interface RowCreateInput {
  cells?: Record<string, CellValue>;
  body?: string;
}

/**
 * Cell patch: provided keys replace, missing keys preserve. Send `null` to
 * clear a cell — the Rust side removes nulls from the stored frontmatter.
 */
export interface RowUpdateInput {
  cells?: Record<string, CellValue>;
  body?: string;
}

export function useAllTables() {
  return useQuery<TableMeta[]>({
    queryKey: ["tables"],
    queryFn: async () => {
      const result = await tauriInvoke<TableMeta[]>("tables_all");
      return result ?? [];
    },
  });
}

export function useTable(id: string | null | undefined) {
  return useQuery<TableDto | null>({
    queryKey: ["table", id],
    queryFn: async () => {
      if (!id) return null;
      const result = await tauriInvoke<TableDto | null>("table_get", { id });
      return result ?? null;
    },
    enabled: !!id,
  });
}

export function useRow(
  tableId: string | null | undefined,
  rowId: string | null | undefined,
) {
  return useQuery<RowDto | null>({
    queryKey: ["row", tableId, rowId],
    queryFn: async () => {
      if (!tableId || !rowId) return null;
      const result = await tauriInvoke<RowDto | null>("row_get", {
        tableId,
        rowId,
      });
      return result ?? null;
    },
    enabled: !!tableId && !!rowId,
  });
}

export function useTableRows(tableId: string | null | undefined) {
  return useQuery<RowDto[]>({
    queryKey: ["rows", tableId],
    queryFn: async () => {
      if (!tableId) return [];
      const result = await tauriInvoke<RowDto[]>("rows_all", { tableId });
      return result ?? [];
    },
    enabled: !!tableId,
  });
}

export function useTableMutations() {
  const qc = useQueryClient();

  const create = useMutation<TableDto, Error, TableCreateInput>({
    mutationFn: async (input) => {
      const created = await tauriInvoke<TableDto>("table_create", {
        input: {
          name: input.name,
          columns: input.columns ?? null,
          views: input.views ?? null,
        },
      });
      if (!created) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData(["table", created.id], created);
      qc.invalidateQueries({ queryKey: ["tables"] });
      return created;
    },
  });

  // Schema patches (rename, add/remove/reorder columns, add/edit views) all
  // go through table_update with full arrays. Frontend builds the next state
  // and posts it; Rust just writes. Optimistic patch updates ["table", id].
  const update = useMutation<
    TableDto,
    Error,
    { id: string; update: TableUpdateInput },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ id, update }) => {
      const updated = await tauriInvoke<TableDto>("table_update", { id, update });
      if (!updated) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData(["table", updated.id], updated);
      qc.invalidateQueries({ queryKey: ["tables"] });
      return updated;
    },
    onMutate: async ({ id, update }) => {
      const snapshots = new Map<readonly unknown[], unknown>();
      const prev = qc.getQueryData<TableDto | null>(["table", id]);
      if (prev) {
        snapshots.set(["table", id], prev);
        qc.setQueryData(["table", id], applyTablePatch(prev, update));
      }
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      if (!ctx) return;
      for (const [k, v] of ctx.snapshots.entries()) qc.setQueryData(k, v);
    },
  });

  const remove = useMutation<void, Error, { id: string }>({
    mutationFn: async ({ id }) => {
      await tauriInvoke<void>("table_delete", { id });
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData(["table", id], null);
      qc.invalidateQueries({ queryKey: ["tables"] });
    },
  });

  return { create, update, remove };
}

const DATABASE_TAG_FAVORITES_KEY = ["databaseTagFavorites"] as const;

/**
 * Starred generated `#tag` tables. Generated tables are virtual (no file),
 * so their favorites live in `data/database-favorites.json` as namespaced
 * keys (`tag:<tag>`). Custom-table favorites ride on the TableMeta instead.
 */
export function useDatabaseTagFavorites() {
  return useQuery<string[]>({
    queryKey: DATABASE_TAG_FAVORITES_KEY,
    queryFn: async () => {
      const result = await tauriInvoke<string[]>("database_tag_favorites_get");
      return result ?? [];
    },
  });
}

/**
 * Toggle a database's favorite. Custom tables persist to `_schema.md`
 * frontmatter (via `table_update`); generated `#tag` tables persist to the
 * vault data file. Both update optimistically so the star flips instantly.
 */
export function useDatabaseFavoriteMutations() {
  const qc = useQueryClient();

  const setTableFavorite = useMutation<
    TableDto,
    Error,
    { id: string; favorite: boolean },
    { snapshot: TableMeta[] | undefined }
  >({
    mutationFn: async ({ id, favorite }) => {
      const updated = await tauriInvoke<TableDto>("table_update", {
        id,
        update: { favorite },
      });
      if (!updated) throw new Error("Tauri runtime missing");
      qc.setQueryData(["table", id], updated);
      void qc.invalidateQueries({ queryKey: ["tables"] });
      return updated;
    },
    onMutate: async ({ id, favorite }) => {
      // Patch the TableMeta list the table + sidebar read from, so the star
      // flips before the refetch lands.
      const snapshot = qc.getQueryData<TableMeta[]>(["tables"]);
      if (snapshot) {
        qc.setQueryData(
          ["tables"],
          snapshot.map((t) => (t.id === id ? { ...t, favorite } : t)),
        );
      }
      return { snapshot };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(["tables"], ctx.snapshot);
    },
  });

  const setTagFavorite = useMutation<
    string[],
    Error,
    { tag: string; favorite: boolean },
    { snapshot: string[] | undefined }
  >({
    mutationFn: async ({ tag, favorite }) => {
      const next = await tauriInvoke<string[]>("database_tag_favorite_set", {
        tag,
        favorite,
      });
      qc.setQueryData(DATABASE_TAG_FAVORITES_KEY, next ?? []);
      return next ?? [];
    },
    onMutate: async ({ tag, favorite }) => {
      const key = `tag:${tag.replace(/^#/, "").toLowerCase()}`;
      const snapshot = qc.getQueryData<string[]>(DATABASE_TAG_FAVORITES_KEY);
      const prev = snapshot ?? [];
      const next = favorite
        ? Array.from(new Set([...prev, key]))
        : prev.filter((k) => k !== key);
      qc.setQueryData(DATABASE_TAG_FAVORITES_KEY, next);
      return { snapshot };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(DATABASE_TAG_FAVORITES_KEY, ctx.snapshot);
    },
  });

  return { setTableFavorite, setTagFavorite };
}

export function useRowMutations(tableId: string) {
  const qc = useQueryClient();

  const create = useMutation<
    RowDto,
    Error,
    RowCreateInput,
    { snapshots: Map<readonly unknown[], unknown>; tempId: string }
  >({
    mutationFn: async (input) => {
      const created = await tauriInvoke<RowDto>("row_create", {
        tableId,
        input: {
          cells: input.cells ?? {},
          body: input.body ?? null,
        },
      });
      if (!created) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      // The surgical placeholder→real swap previously lived in onSuccess
      // — it needed the tempId from onMutate's context, which isn't
      // reachable from here. Falling back to invalidate: the
      // onMutate-inserted optimistic row goes away when the list
      // refetches, and the real row takes its place.
      qc.setQueryData(["row", tableId, created.id], created);
      qc.invalidateQueries({ queryKey: ["rows", tableId] });
      qc.invalidateQueries({ queryKey: ["tables"] });
      return created;
    },
    onMutate: async (input) => {
      const snapshots = new Map<readonly unknown[], unknown>();
      // Optimistic insert at end (matches default created-asc sort).
      const tempId = `row_temp_${Date.now()}`;
      const placeholder: RowDto = {
        id: tempId,
        path: `tables/${tableId}/${tempId}.md`,
        table: tableId,
        created: new Date().toISOString(),
        cells: (input.cells ?? {}) as Record<string, CellValue>,
        body: input.body ?? "",
      };
      const list = qc.getQueryData<RowDto[]>(["rows", tableId]);
      if (list) {
        snapshots.set(["rows", tableId], list);
        qc.setQueryData(["rows", tableId], [...list, placeholder]);
      }
      return { snapshots, tempId };
    },
    onError: (_e, _v, ctx) => {
      if (!ctx) return;
      for (const [k, v] of ctx.snapshots.entries()) qc.setQueryData(k, v);
    },
  });

  const update = useMutation<
    RowDto,
    Error,
    { rowId: string; update: RowUpdateInput },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ rowId, update }) => {
      const updated = await tauriInvoke<RowDto>("row_update", {
        tableId,
        rowId,
        update: {
          cells: update.cells ?? null,
          body: update.body ?? null,
        },
      });
      if (!updated) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData(["row", tableId, updated.id], updated);
      qc.invalidateQueries({ queryKey: ["rows", tableId] });
      return updated;
    },
    onMutate: async ({ rowId, update }) => {
      const snapshots = new Map<readonly unknown[], unknown>();
      const prevSingle = qc.getQueryData<RowDto | null>(["row", tableId, rowId]);
      if (prevSingle) {
        snapshots.set(["row", tableId, rowId], prevSingle);
        qc.setQueryData(
          ["row", tableId, rowId],
          applyRowPatch(prevSingle, update),
        );
      }
      const list = qc.getQueryData<RowDto[]>(["rows", tableId]);
      if (Array.isArray(list)) {
        const idx = list.findIndex((r) => r.id === rowId);
        if (idx !== -1) {
          snapshots.set(["rows", tableId], list);
          const next = [...list];
          next[idx] = applyRowPatch(list[idx], update);
          qc.setQueryData(["rows", tableId], next);
        }
      }
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      if (!ctx) return;
      for (const [k, v] of ctx.snapshots.entries()) qc.setQueryData(k, v);
    },
  });

  const remove = useMutation<
    void,
    Error,
    { rowId: string; retainDetail?: boolean },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ rowId }) => {
      await tauriInvoke<void>("row_delete", { tableId, rowId });
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.invalidateQueries({ queryKey: ["tables"] });
    },
    onMutate: async ({ rowId, retainDetail }) => {
      const snapshots = new Map<readonly unknown[], unknown>();
      const list = qc.getQueryData<RowDto[]>(["rows", tableId]);
      if (Array.isArray(list)) {
        snapshots.set(["rows", tableId], list);
        qc.setQueryData(
          ["rows", tableId],
          list.filter((r) => r.id !== rowId),
        );
      }
      const prevSingle = qc.getQueryData<RowDto | null>(["row", tableId, rowId]);
      if (prevSingle !== undefined) {
        snapshots.set(["row", tableId, rowId], prevSingle);
        if (!retainDetail) qc.setQueryData(["row", tableId, rowId], null);
      }
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      if (!ctx) return;
      for (const [k, v] of ctx.snapshots.entries()) qc.setQueryData(k, v);
    },
  });

  const reorder = useMutation<RowDto[], Error, { rowIds: string[] }>({
    mutationFn: async ({ rowIds }) => {
      const updated = await tauriInvoke<RowDto[]>("row_reorder", {
        tableId,
        input: { rowIds },
      });
      if (!updated) throw new Error("Tauri runtime missing");
      qc.setQueryData(["rows", tableId], updated);
      for (const row of updated) qc.setQueryData(["row", tableId, row.id], row);
      return updated;
    },
  });

  return { create, update, remove, reorder };
}

function applyTablePatch(table: TableDto, patch: TableUpdateInput): TableDto {
  const next: TableDto = { ...table };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.columns !== undefined) next.columns = patch.columns;
  if (patch.views !== undefined) next.views = patch.views;
  if (patch.favorite !== undefined) next.favorite = patch.favorite;
  return next;
}

function applyRowPatch(row: RowDto, patch: RowUpdateInput): RowDto {
  const next: RowDto = { ...row, cells: { ...row.cells } };
  if (patch.cells) {
    for (const [k, v] of Object.entries(patch.cells)) {
      if (v === null) delete next.cells[k];
      else next.cells[k] = v;
    }
  }
  if (patch.body !== undefined) next.body = patch.body;
  return next;
}

// Re-export for callers that don't need the full DTO surface.
export type { QueryClient };
