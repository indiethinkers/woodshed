"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";
import { addWikilinkTarget } from "@/lib/wikilinks";

export interface ResourceDto {
  id: string;
  path: string;
  title: string;
  url: string;
  source: string;
  saved: string;
  author?: string;
  published?: string;
  capturedAt?: string;
  contentHash?: string;
  tags: string[];
  highlights: string[];
  favorite: boolean;
  body: string;
}

export interface ResourceCreateInput {
  title: string;
  url: string;
  source?: string;
  tags?: string[];
  highlights?: string[];
  body?: string;
}

export interface ResourceUpdateInput {
  title?: string;
  url?: string;
  source?: string;
  author?: string;
  published?: string;
  capturedAt?: string;
  contentHash?: string;
  tags?: string[];
  highlights?: string[];
  favorite?: boolean;
  body?: string;
}

export interface ResourceCaptureUrlInput {
  url: string;
  tags?: string[];
  title?: string;
  source?: string;
  author?: string;
  published?: string;
  highlights?: string[];
  /** Skip appending a link to today's daily page — set when the caller lives
   *  on a daily page (the append would race the journal editor's autosave). */
  skipDailyLog?: boolean;
}

export function useAllResources() {
  return useQuery<ResourceDto[]>({
    queryKey: ["resources"],
    queryFn: async () => {
      const result = await tauriInvoke<ResourceDto[]>("resources_all");
      return result ?? [];
    },
  });
}

export function useResource(id: string | null | undefined) {
  return useQuery<ResourceDto | null>({
    queryKey: ["resource", id],
    queryFn: async () => {
      if (!id) return null;
      const result = await tauriInvoke<ResourceDto | null>("resource_get", {
        id,
      });
      return result ?? null;
    },
    enabled: !!id,
  });
}

export function useResourceMutations() {
  const qc = useQueryClient();

  const create = useMutation<ResourceDto, Error, ResourceCreateInput>({
    mutationFn: async (input) => {
      const created = await tauriInvoke<ResourceDto>("resource_create", {
        input: {
          title: input.title,
          url: input.url,
          source: input.source ?? null,
          tags: input.tags ?? [],
          highlights: input.highlights ?? [],
          body: input.body ?? null,
        },
      });
      if (!created) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      cacheResourceWrite(qc, created);
      return created;
    },
  });

  const capture = useMutation<ResourceDto, Error, ResourceCaptureUrlInput>({
    mutationFn: async (input) => {
      const captured = await tauriInvoke<ResourceDto>("resource_capture_url", {
        input: {
          url: input.url,
          tags: input.tags ?? [],
          title: input.title ?? null,
          source: input.source ?? null,
          author: input.author ?? null,
          published: input.published ?? null,
          highlights: input.highlights ?? [],
          skipDailyLog: input.skipDailyLog ?? false,
        },
      });
      if (!captured) throw new Error("Tauri runtime missing");
      cacheResourceWrite(qc, captured);
      // Capture may have created a new person for the author byline; refresh
      // the people list so the detail view resolves the link immediately
      // rather than waiting on the ~500ms watcher round-trip.
      void qc.invalidateQueries({ queryKey: ["people"] });
      return captured;
    },
  });

  const update = useMutation<
    ResourceDto,
    Error,
    { id: string; update: ResourceUpdateInput },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ id, update }) => {
      const updated = await tauriInvoke<ResourceDto>("resource_update", {
        id,
        update,
      });
      if (!updated) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      cacheResourceWrite(qc, updated);
      qc.invalidateQueries({ queryKey: ["resources"] });
      return updated;
    },
    onMutate: async ({ id, update }) => {
      const snapshots = new Map<readonly unknown[], unknown>();

      const prevSingle = qc.getQueryData<ResourceDto | null>(["resource", id]);
      if (prevSingle) {
        snapshots.set(["resource", id], prevSingle);
        qc.setQueryData(
          ["resource", id],
          applyOptimisticPatch(prevSingle, update),
        );
      }

      qc.getQueriesData<ResourceDto[]>({ queryKey: ["resources"] }).forEach(
        ([key, value]) => {
          if (!Array.isArray(value)) return;
          const idx = value.findIndex((b) => b.id === id);
          if (idx === -1) return;
          snapshots.set(key, value);
          const next = [...value];
          next[idx] = applyOptimisticPatch(value[idx], update);
          qc.setQueryData(key, next);
        },
      );

      return { snapshots };
    },
    onError: (_err, _vars, context) => {
      if (!context) return;
      for (const [key, value] of context.snapshots.entries()) {
        qc.setQueryData(key, value);
      }
    },
  });

  const remove = useMutation<
    void,
    Error,
    { id: string; retainDetail?: boolean },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ id }) => {
      await tauriInvoke<void>("resource_delete", { id });
      // The delete scrubs the resource's creation-trace backlink from the
      // day's journal — refresh any cached daily page so it clears.
      void qc.invalidateQueries({ queryKey: ["dailyJournal"] });
    },
    onMutate: async ({ id, retainDetail }) => {
      const snapshots = new Map<readonly unknown[], unknown>();

      const prevSingle = qc.getQueryData<ResourceDto | null>(["resource", id]);
      if (prevSingle !== undefined) {
        snapshots.set(["resource", id], prevSingle);
        if (!retainDetail) qc.setQueryData(["resource", id], null);
      }

      qc.getQueriesData<ResourceDto[]>({ queryKey: ["resources"] }).forEach(
        ([key, value]) => {
          if (!Array.isArray(value)) return;
          const idx = value.findIndex((b) => b.id === id);
          if (idx === -1) return;
          snapshots.set(key, value);
          qc.setQueryData(
            key,
            value.filter((b) => b.id !== id),
          );
        },
      );

      return { snapshots };
    },
    onError: (_err, _vars, context) => {
      if (!context) return;
      for (const [key, value] of context.snapshots.entries()) {
        qc.setQueryData(key, value);
      }
    },
  });

  return { create, capture, update, remove };
}

function applyOptimisticPatch(
  resource: ResourceDto,
  update: ResourceUpdateInput,
): ResourceDto {
  const next: ResourceDto = { ...resource };
  if (update.title !== undefined) next.title = update.title;
  if (update.url !== undefined) next.url = update.url;
  if (update.source !== undefined) next.source = update.source;
  if (update.author !== undefined) next.author = update.author;
  if (update.published !== undefined) next.published = update.published;
  if (update.capturedAt !== undefined) next.capturedAt = update.capturedAt;
  if (update.contentHash !== undefined) next.contentHash = update.contentHash;
  if (update.tags !== undefined) next.tags = update.tags;
  if (update.highlights !== undefined) next.highlights = update.highlights;
  if (update.favorite !== undefined) next.favorite = update.favorite;
  if (update.body !== undefined) next.body = update.body;
  return next;
}

function upsertInList(
  qc: QueryClient,
  key: readonly unknown[],
  resource: ResourceDto,
) {
  const current = qc.getQueryData<ResourceDto[]>(key);
  if (!current) return;
  const idx = current.findIndex((b) => b.id === resource.id);
  const next =
    idx === -1
      ? [resource, ...current]
      : current.map((b) => (b.id === resource.id ? resource : b));
  next.sort((a, b) => b.saved.localeCompare(a.saved));
  qc.setQueryData(key, next);
}

function cacheResourceWrite(qc: QueryClient, resource: ResourceDto) {
  upsertInList(qc, ["resources"], resource);
  qc.setQueryData(["resource", resource.id], resource);
  addWikilinkTarget({
    kind: "resource",
    docId: resource.id,
    title: resource.title,
    href: `/resources/${resource.id}`,
  });
  void qc.invalidateQueries({ queryKey: ["wikilinkTargets"] });
  void qc.invalidateQueries({ queryKey: ["dailyJournal"] });
}
