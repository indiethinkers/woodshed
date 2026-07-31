"use client";

import { useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";
import type { AreaId } from "@/lib/types";
import { addWikilinkTarget } from "@/lib/wikilinks";

// People cache: single source of truth.
//
// Previous architecture maintained two parallel caches — `["people"]` for the
// list and `["person", id]` for each detail page — kept in sync by mutations,
// watcher events, and a defensive fallback chain inside the per-id queryFn.
// That fanned out into a race on the wikilink `[[Create person]]` flow:
// `usePerson` and `useAllPeople` mount together on `/people/<id>`, fire their
// queryFns concurrently, and `person_get` could resolve null and throw before
// `people_all` had finished populating the list — so the fallback chain found
// nothing to fall back on, and the detail panel locked into "Person not
// found" even though the file was on disk and would appear in the list a
// moment later.
//
// Both hooks now share the `["people"]` query. `usePerson(id)` is a
// `select` projection of the same fetch; there is no separate `person_get`
// command call from the detail page. Race eliminated by construction —
// `usePerson` either sees the list (and finds or doesn't find the person)
// or doesn't (and is loading). Mutations touch only `["people"]`; the
// watcher invalidates only `["people"]`.
//
// There is no separate per-id Tauri read command; list and detail reads share
// `people_all` and one React Query cache.

export interface PersonDto {
  id: string;
  path: string;
  name: string;
  initials: string;
  role: string;
  company: string;
  email: string;
  /** Free-text relationship note, maintained manually. Empty when unset. */
  relationship: string;
  /** Absent when the person isn't assigned to any area. */
  area?: AreaId;
  avatar?: string;
  /** Filesystem creation time (RFC 3339), derived from the file's birth time. */
  created?: string;
  /** Filesystem last-modified time (RFC 3339) — Finder's "Date Modified". */
  updated?: string;
  favorite: boolean;
  body: string;
}

export interface PersonCreateInput {
  name: string;
  role: string;
  company: string;
  email: string;
  area?: AreaId | null;
  initials?: string;
  avatar?: string;
  body?: string;
}

export interface PersonUpdateInput {
  name?: string;
  initials?: string;
  role?: string;
  company?: string;
  email?: string;
  relationship?: string;
  /** Use null to clear the area; undefined leaves it alone. */
  area?: AreaId | null;
  /** Use null to clear the avatar; undefined leaves it alone. */
  avatar?: string | null;
  favorite?: boolean;
  body?: string;
}

const PEOPLE_KEY = ["people"] as const;

async function fetchPeople(): Promise<PersonDto[]> {
  const result = await tauriInvoke<PersonDto[]>("people_all");
  return result ?? [];
}

export function useAllPeople() {
  return useQuery<PersonDto[]>({
    queryKey: PEOPLE_KEY,
    queryFn: fetchPeople,
  });
}

/**
 * Single person by id, composed from the shared list query.
 *
 * Implemented as a pure selector over `useAllPeople` (rather than a
 * second `useQuery` with `select` on the same key) so the people index
 * observer can't briefly see the per-id select's nullable result —
 * TanStack v5 keeps per-observer state separate in principle, but the
 * memory of dual observers on one key with different return shapes is
 * a footgun I don't want loaded.
 *
 * Returns:
 *   - `{ data: PersonDto, isLoading: false }`   — found
 *   - `{ data: null,      isLoading: false }`   — list loaded, id missing
 *   - `{ data: undefined, isLoading: true }`    — list still loading
 */
export function usePerson(id: string | null | undefined): {
  data: PersonDto | null | undefined;
  isLoading: boolean;
} {
  const { data: people, isLoading } = useAllPeople();
  return useMemo(() => {
    if (!id) return { data: null, isLoading: false };
    if (isLoading && !people) return { data: undefined, isLoading: true };
    const list = people ?? [];
    return { data: list.find((p) => p.id === id) ?? null, isLoading: false };
  }, [id, people, isLoading]);
}

export function usePeopleMutations() {
  const qc = useQueryClient();

  const create = useMutation<PersonDto, Error, PersonCreateInput>({
    mutationFn: async (input) => {
      const created = await tauriInvoke<PersonDto>("person_create", {
        input: {
          name: input.name,
          role: input.role,
          company: input.company,
          email: input.email,
          area: input.area,
          initials: input.initials ?? null,
          avatar: input.avatar ?? null,
          body: input.body ?? null,
        },
      });
      if (!created) throw new Error("Tauri runtime missing");
      // Update the shared list cache so the detail-page `select`
      // projection finds the new row immediately. Cancel any
      // refetch in-flight on `["people"]` so a slightly-stale
      // people_all response (called before the file landed) can't
      // overwrite this fresh write.
      await qc.cancelQueries({ queryKey: PEOPLE_KEY });
      cachePersonWrite(qc, created);
      await qc.invalidateQueries({ queryKey: PEOPLE_KEY });
      // New email/id mapping — re-resolve attendees on any open event.
      invalidateAttendeeResolution(qc);
      // The backend logs the creation on today's Cadence page; that write is
      // a self-write the watcher filters, so refresh the journal explicitly.
      void qc.invalidateQueries({ queryKey: ["dailyJournal"] });
      return created;
    },
  });

  const update = useMutation<
    PersonDto,
    Error,
    { id: string; update: PersonUpdateInput },
    { snapshot: PersonDto[] | undefined }
  >({
    mutationFn: async ({ id, update }) => {
      const updated = await tauriInvoke<PersonDto>("person_update", { id, update });
      if (!updated) throw new Error("Tauri runtime missing");
      // Write the canonical post-mutation row into the shared cache
      // from inside `mutationFn` rather than `onSuccess`, so the
      // update survives if the observer unmounts mid-flight (a real
      // scenario when the user types in a field and immediately
      // navigates away).
      cachePersonWrite(qc, updated);
      // Only name/email feed attendee resolution; skip the event refetch
      // for area/avatar/body/role edits that can't change a chip.
      if (update.name !== undefined || update.email !== undefined) {
        invalidateAttendeeResolution(qc);
      }
      return updated;
    },
    onMutate: async ({ id, update }) => {
      const snapshot = qc.getQueryData<PersonDto[]>(PEOPLE_KEY);
      if (snapshot) {
        const idx = snapshot.findIndex((p) => p.id === id);
        if (idx !== -1) {
          const next = [...snapshot];
          next[idx] = applyOptimisticPatch(snapshot[idx], update);
          next.sort((a, b) =>
            a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
          );
          qc.setQueryData(PEOPLE_KEY, next);
        }
      }
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot) qc.setQueryData(PEOPLE_KEY, context.snapshot);
    },
  });

  const remove = useMutation<
    void,
    Error,
    { id: string; retainDetail?: boolean },
    { snapshot: PersonDto[] | undefined }
  >({
    mutationFn: async ({ id }) => {
      await tauriInvoke<void>("person_delete", { id });
      // Mapping gone — attendees that resolved to this person revert to
      // raw emails/ids on the next event read.
      invalidateAttendeeResolution(qc);
      // The delete scrubs the person's creation trace from the day's journal
      // — refresh any cached daily page so it clears.
      void qc.invalidateQueries({ queryKey: ["dailyJournal"] });
      void qc.invalidateQueries({ queryKey: ["wikilinkTargets"] });
    },
    onMutate: async ({ id, retainDetail }) => {
      const snapshot = qc.getQueryData<PersonDto[]>(PEOPLE_KEY);
      if (snapshot && !retainDetail) {
        qc.setQueryData(
          PEOPLE_KEY,
          snapshot.filter((p) => p.id !== id),
        );
      }
      return { snapshot };
    },
    onSuccess: (_data, { id }) => {
      const people = qc.getQueryData<PersonDto[]>(PEOPLE_KEY);
      if (people) qc.setQueryData(PEOPLE_KEY, people.filter((person) => person.id !== id));
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot) qc.setQueryData(PEOPLE_KEY, context.snapshot);
    },
  });

  const setAvatar = useMutation<
    PersonDto,
    Error,
    { id: string; file: File }
  >({
    mutationFn: async ({ id, file }) => {
      if (file.size === 0 || file.size > 20 * 1024 * 1024) {
        throw new Error("Avatar images must be between 1 byte and 20 MiB");
      }
      const ext = extractAvatarExt(file);
      const buffer = await file.arrayBuffer();
      // Tauri encodes Vec<u8> as a number[] over the JSON bridge. The
      // payload is one-shot (immediately written to disk) so the
      // memory copy here isn't a steady-state cost.
      const bytes = Array.from(new Uint8Array(buffer));
      const updated = await tauriInvoke<PersonDto>("person_avatar_set", {
        id,
        bytes,
        ext,
      });
      if (!updated) throw new Error("Tauri runtime missing");
      upsertPeople(qc, updated);
      return updated;
    },
  });

  const clearAvatar = useMutation<PersonDto, Error, { id: string }>({
    mutationFn: async ({ id }) => {
      const updated = await tauriInvoke<PersonDto>("person_avatar_clear", { id });
      if (!updated) throw new Error("Tauri runtime missing");
      upsertPeople(qc, updated);
      return updated;
    },
  });

  return { create, update, remove, setAvatar, clearAvatar };
}

/**
 * Pull an extension the backend will accept from a browser-supplied
 * File. Prefer the filename suffix when the user picks an
 * unambiguously-named file; fall back to the MIME type for paste-from-
 * clipboard cases where there's no name. Unknown types resolve to
 * "jpg" so the upload still succeeds (the backend will reject it
 * cleanly if the bytes really aren't an image).
 */
function extractAvatarExt(file: File): string {
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    return name.slice(dot + 1);
  }
  const mime = file.type.toLowerCase();
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "jpg";
}

function applyOptimisticPatch(
  person: PersonDto,
  update: PersonUpdateInput,
): PersonDto {
  const next: PersonDto = { ...person };
  if (update.name !== undefined) next.name = update.name;
  if (update.initials !== undefined) next.initials = update.initials;
  if (update.role !== undefined) next.role = update.role;
  if (update.company !== undefined) next.company = update.company;
  if (update.email !== undefined) next.email = update.email;
  if (update.relationship !== undefined) next.relationship = update.relationship;
  if (update.area !== undefined) {
    next.area = update.area === null ? undefined : update.area;
  }
  if (update.avatar !== undefined) {
    next.avatar = update.avatar === null ? undefined : update.avatar;
  }
  if (update.favorite !== undefined) next.favorite = update.favorite;
  if (update.body !== undefined) next.body = update.body;
  return next;
}

/**
 * A person's name/email feeds server-side attendee resolution on events
 * (`enrich_resolved_attendees`). After adding, removing, or renaming a
 * person, refresh the event queries so any open calendar / event page
 * re-resolves attendees — e.g. a freshly-added contact lights up as a
 * linked attendee instead of a plain email. The watcher's self-write
 * filter drops our own person writes before they reach `invalidateForPath`,
 * so the mutation has to do this itself. Person mutations are infrequent,
 * so the coarse event invalidation is acceptable.
 */
function invalidateAttendeeResolution(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: ["events"] });
  qc.invalidateQueries({ queryKey: ["event"] });
}

function upsertPeople(qc: QueryClient, person: PersonDto): void {
  const current = qc.getQueryData<PersonDto[]>(PEOPLE_KEY) ?? [];
  const idx = current.findIndex((p) => p.id === person.id);
  const next =
    idx === -1
      ? [...current, person]
      : current.map((p) => (p.id === person.id ? person : p));
  next.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  qc.setQueryData(PEOPLE_KEY, next);
}

function cachePersonWrite(qc: QueryClient, person: PersonDto): void {
  upsertPeople(qc, person);
  addWikilinkTarget({
    kind: "person",
    docId: person.id,
    title: person.name,
    href: `/people/${person.id}`,
  });
  void qc.invalidateQueries({ queryKey: ["wikilinkTargets"] });
}
