"use client";

import { useEffect, useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";
import type { AreaId } from "@/lib/types";
import { addWikilinkTarget } from "@/lib/wikilinks";

// Notes cache: single source of truth on the `["notes"]` list query.
// Detail hook is a `useMemo` selector over the same list — mirrors the
// people-side rearchitecture (see use-people.ts). The wikilink
// `[[Create note]]` flow used to race the per-id `note_get` against the
// list refetch the same way the people flow did; collapsing both to a
// single query eliminates the race by construction.

export interface NoteDto {
  id: string;
  path: string;
  revision: string;
  title: string;
  /** Absent when the user hasn't assigned the note to any area. */
  area?: AreaId;
  /** ISO 8601 timestamp; serialized verbatim from the file. */
  created: string;
  tags: string[];
  favorite: boolean;
  body: string;
}

export interface NoteCreateInput {
  title: string;
  area?: AreaId | null;
  tags?: string[];
  body?: string;
}

export interface NoteUpdateInput {
  title?: string;
  /** `null` clears the area; omitting the key leaves it untouched. */
  area?: AreaId | null;
  tags?: string[];
  favorite?: boolean;
  body?: string;
}

const NOTES_KEY = ["notes"] as const;

async function fetchNotes(): Promise<NoteDto[]> {
  const result = await tauriInvoke<NoteDto[]>("notes_all");
  if (result === null) {
    throw new Error("notes_all returned no data");
  }
  return result;
}

async function fetchNote(id: string): Promise<NoteDto | null> {
  const result = await tauriInvoke<NoteDto | null>("note_get", { id });
  return result ?? null;
}

export function useAllNotes() {
  return useQuery<NoteDto[]>({
    queryKey: NOTES_KEY,
    queryFn: fetchNotes,
  });
}

/**
 * Single note by id, composed from the shared list query. Same shape
 * and rationale as `usePerson` — see use-people.ts.
 */
export function useNote(id: string | null | undefined): {
  data: NoteDto | null | undefined;
  isLoading: boolean;
} {
  const qc = useQueryClient();
  const {
    data: notes,
    isError: listIsError,
    isFetching: listIsFetching,
    isLoading: listIsLoading,
  } = useAllNotes();
  const cachedNote = useMemo(() => {
    if (!id || !notes) return null;
    return notes.find((n) => n.id === id) ?? null;
  }, [id, notes]);
  const shouldLookupById =
    Boolean(id) &&
    !cachedNote &&
    (listIsError || (!listIsLoading && !listIsFetching));
  const fallback = useQuery<NoteDto | null>({
    queryKey: ["noteLookup", id],
    queryFn: () => (id ? fetchNote(id) : Promise.resolve(null)),
    enabled: shouldLookupById,
    retry: 1,
  });

  useEffect(() => {
    if (!fallback.data) return;
    cacheNoteWrite(qc, fallback.data);
  }, [fallback.data, qc]);

  return useMemo(() => {
    if (!id) return { data: null, isLoading: false };
    if (cachedNote) return { data: cachedNote, isLoading: false };
    if ((listIsLoading && !notes) || listIsFetching) {
      return { data: undefined, isLoading: true };
    }
    if (fallback.isLoading || fallback.isFetching) {
      return { data: undefined, isLoading: true };
    }
    if (fallback.data) return { data: fallback.data, isLoading: false };
    return { data: null, isLoading: false };
  }, [
    cachedNote,
    fallback.data,
    fallback.isFetching,
    fallback.isLoading,
    id,
    listIsFetching,
    listIsLoading,
    notes,
  ]);
}

export function useNoteMutations() {
  const qc = useQueryClient();

  const create = useMutation<NoteDto, Error, NoteCreateInput>({
    mutationFn: async (input) => {
      const created = await tauriInvoke<NoteDto>("note_create", {
        input: {
          title: input.title,
          area: input.area,
          tags: input.tags ?? [],
          body: input.body ?? null,
        },
      });
      if (!created) throw new Error("Tauri runtime missing");
      // Cancel any in-flight notes_all so a slightly-stale fetch
      // (started before the new file landed) can't overwrite this
      // upsert.
      await qc.cancelQueries({ queryKey: NOTES_KEY });
      cacheNoteWrite(qc, created);
      // The backend logs the creation on today's Cadence page; that write is
      // a self-write the watcher filters, so refresh the journal explicitly.
      void qc.invalidateQueries({ queryKey: ["dailyJournal"] });
      return created;
    },
  });

  const update = useMutation<
    NoteDto,
    Error,
    { id: string; update: NoteUpdateInput },
    { snapshot: NoteDto[] | undefined; previousId: string }
  >({
    mutationFn: async ({ id, update }) => {
      const current = findCachedNote(qc, id);
      let updated: NoteDto | null;
      try {
        updated = await invokeNoteUpdate(id, update, current);
      } catch (err) {
        if (isBodyStaleBaseError(update, err)) {
          const fresh = await fetchNote(id);
          if (fresh) cacheNoteWrite(qc, fresh);
        }
        throw err;
      }
      if (!updated) throw new Error("Tauri runtime missing");
      // The backend treats note ids as immutable after creation, but keep
      // the old-id cleanup for defensive compatibility with older runtimes.
      if (id !== updated.id) {
        removeFromList(qc, id);
      }
      cacheNoteWrite(qc, updated);
      return updated;
    },
    onMutate: async ({ id, update }) => {
      if (update.body !== undefined) {
        return { snapshot: undefined, previousId: id };
      }
      const snapshot = qc.getQueryData<NoteDto[]>(NOTES_KEY);
      if (snapshot) {
        const idx = snapshot.findIndex((n) => n.id === id);
        if (idx !== -1) {
          const next = [...snapshot];
          next[idx] = applyOptimisticPatch(snapshot[idx], update);
          qc.setQueryData(NOTES_KEY, next);
        }
      }
      return { snapshot, previousId: id };
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot) qc.setQueryData(NOTES_KEY, context.snapshot);
    },
  });

  const remove = useMutation<
    void,
    Error,
    { id: string },
    { snapshot: NoteDto[] | undefined }
  >({
    mutationFn: async ({ id }) => {
      await tauriInvoke<void>("note_delete", { id });
      // The delete scrubs the note's creation trace from the
      // day's journal — refresh any cached daily page so the backlink clears.
      void qc.invalidateQueries({ queryKey: ["dailyJournal"] });
      void qc.invalidateQueries({ queryKey: ["wikilinkTargets"] });
    },
    onMutate: async ({ id }) => {
      const snapshot = qc.getQueryData<NoteDto[]>(NOTES_KEY);
      if (snapshot) {
        qc.setQueryData(
          NOTES_KEY,
          snapshot.filter((n) => n.id !== id),
        );
      }
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot) qc.setQueryData(NOTES_KEY, context.snapshot);
    },
  });

  return { create, update, remove };
}

function applyOptimisticPatch(note: NoteDto, update: NoteUpdateInput): NoteDto {
  const next: NoteDto = { ...note };
  if (update.title !== undefined) next.title = update.title;
  if (update.area !== undefined) {
    next.area = update.area === null ? undefined : update.area;
  }
  if (update.tags !== undefined) next.tags = update.tags;
  if (update.favorite !== undefined) next.favorite = update.favorite;
  if (update.body !== undefined) next.body = update.body;
  return next;
}

function isBodyStaleBaseError(update: NoteUpdateInput, err: unknown): boolean {
  if (update.body === undefined) return false;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("note changed on disk");
}

function findCachedNote(qc: QueryClient, id: string): NoteDto {
  const current = qc.getQueryData<NoteDto[]>(NOTES_KEY) ?? [];
  const note = current.find((n) => n.id === id);
  if (!note) throw new Error(`note not in cache: ${id}`);
  return note;
}

async function invokeNoteUpdate(
  id: string,
  update: NoteUpdateInput,
  current: NoteDto,
): Promise<NoteDto | null> {
  const identity = {
    expectedPath: current.path,
    expectedCreated: current.created,
  };
  const hasBody = update.body !== undefined;
  const hasTitle = update.title !== undefined;
  const hasMetadata =
    update.area !== undefined ||
    update.tags !== undefined ||
    update.favorite !== undefined;
  if (hasBody && (hasTitle || hasMetadata)) {
    throw new Error("body updates cannot be mixed with title or metadata");
  }
  if (hasBody) {
    return tauriInvoke<NoteDto>("note_update_body", {
      id,
      input: {
        body: update.body ?? "",
        baseRevision: current.revision,
        ...identity,
      },
    });
  }
  if (hasTitle) {
    return tauriInvoke<NoteDto>("note_update_title", {
      id,
      input: {
        title: update.title ?? "",
        ...identity,
      },
    });
  }
  return tauriInvoke<NoteDto>("note_update_metadata", {
    id,
    input: {
      ...(update.area !== undefined ? { area: update.area } : {}),
      ...(update.tags !== undefined ? { tags: update.tags } : {}),
      ...(update.favorite !== undefined ? { favorite: update.favorite } : {}),
      ...identity,
    },
  });
}

function upsertNote(qc: QueryClient, note: NoteDto): void {
  const current = qc.getQueryData<NoteDto[]>(NOTES_KEY) ?? [];
  const idx = current.findIndex((n) => n.id === note.id);
  const next =
    idx === -1
      ? [note, ...current]
      : current.map((n) => (n.id === note.id ? note : n));
  next.sort((a, b) => b.created.localeCompare(a.created));
  qc.setQueryData(NOTES_KEY, next);
}

function cacheNoteWrite(qc: QueryClient, note: NoteDto): void {
  upsertNote(qc, note);
  addWikilinkTarget({
    kind: "note",
    docId: note.id,
    title: note.title,
    href: `/notebook/${note.id}`,
  });
  void qc.invalidateQueries({ queryKey: ["wikilinkTargets"] });
}

function removeFromList(qc: QueryClient, id: string): void {
  const current = qc.getQueryData<NoteDto[]>(NOTES_KEY);
  if (!current) return;
  qc.setQueryData(
    NOTES_KEY,
    current.filter((n) => n.id !== id),
  );
}
