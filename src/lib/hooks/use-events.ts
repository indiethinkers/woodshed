"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";
import type { RecurringRule, AreaId } from "@/lib/types";

/** Origin of an event. `undefined` on `EventDto.provider` means
 *  vault-local (created via "+ Add event"); explicit values flag
 *  external syncs. iCal subscriptions are read-only — the backend
 *  rejects mutations against `writable === false` records. */
export type EventProvider = "ical";

/**
 * One row of the per-event attendee list, joined server-side against
 * the People folder via the people-email index. Same length and
 * ordering as `EventDto.attendees`. Matched attendees render as
 * clickable wikilinks to `/people/<personId>`; unmatched entries
 * render `name` (a fallback derived from the email or raw id) as
 * plain text.
 */
export interface AttendeeDto {
  raw: string;
  personId?: string;
  name: string;
  email?: string;
}

export interface EventDto {
  id: string;
  path: string;
  title: string;
  subtitle?: string;
  /** ISO datetime. For recurring instances this is the projected occurrence
   *  for the queried date, not the source file's `date` field. */
  date: string;
  duration: number;
  area: AreaId;
  attendees: string[];
  /** Resolved counterparts to `attendees`, populated by the backend at
   *  read time. Always parallel to `attendees` (same length, same
   *  index ordering). */
  resolvedAttendees: AttendeeDto[];
  recurring: RecurringRule;
  provider?: EventProvider;
  /** Stable id of the source calendar (e.g. "gcal_01HW…"). Threaded
   *  through to the schedule UI so the colored left-border stripe can
   *  look up the account's color. */
  accountId?: string;
  externalId?: string;
  /** `undefined` ≡ writable (vault-local default). iCal events
   *  explicitly carry `false`. */
  writable?: boolean;
  /** Original `RRULE:` line preserved when the external feed used a
   *  recurrence pattern our enum can't render. Round-trip safety for
   *  Phase 2b's write-back path. */
  rruleOriginal?: string;
  /** User-applied tags. `event` is implicit from `type: event` and is
   *  NOT stored here. */
  tags?: string[];
  /** Cleaned-up event description (only present on iCal events; the
   *  backend strips HTML, unwraps Google redirects, and collapses
   *  blank-line runs). Vault-local events stash everything they have
   *  to say about themselves in `body`. */
  description?: string;
  /** First Zoom/Meet/Teams/Webex URL detected in the description or
   *  LOCATION. Rendered as a prominent "Join meeting" button so the
   *  user doesn't have to fish the link out of the description text. */
  meetingUrl?: string;
  /** True when this iCal event has a local override file whose
   *  title / date / duration differs from the gcal cache. Frontend
   *  surfaces a "Modified locally" badge so the divergence from the
   *  upstream calendar is visible. Always undefined on vault-local
   *  events. */
  localOverrides?: boolean;
  body: string;
}

export interface EventCreateInput {
  title: string;
  date: string;
  duration: number;
  area: AreaId;
  attendees?: string[];
  recurring?: RecurringRule;
  subtitle?: string;
  tags?: string[];
  body?: string;
}

export interface EventUpdateInput {
  title?: string;
  subtitle?: string | null;
  date?: string;
  duration?: number;
  area?: AreaId;
  attendees?: string[];
  recurring?: RecurringRule;
  tags?: string[];
  body?: string;
}

export function useEvents(date: string) {
  return useQuery<EventDto[]>({
    queryKey: ["events", date],
    queryFn: async () => {
      const result = await tauriInvoke<EventDto[]>("events_for_date", { date });
      return result ?? [];
    },
    enabled: !!date,
  });
}

/** Find an already-loaded event by id across every cached schedule-day
 *  list (`["events", <date>]`). The list DTO is the same shape `event_get`
 *  returns — body and resolved attendees included — so it's a safe seed
 *  for the detail query. See `useEvent`'s `placeholderData`. */
function findEventInLists(qc: QueryClient, id: string): EventDto | undefined {
  for (const [, list] of qc.getQueriesData<EventDto[]>({
    queryKey: ["events"],
  })) {
    if (!Array.isArray(list)) continue;
    const hit = list.find((e) => e.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** iCal counterpart to `findEventInLists`. iCal rows are keyed by
 *  (accountId, externalId) + the projected occurrence date rather than by
 *  their synthetic id, so match on those. */
function findIcalEventInLists(
  qc: QueryClient,
  accountId: string,
  externalId: string,
  occurrenceDate?: string,
): EventDto | undefined {
  for (const [, list] of qc.getQueriesData<EventDto[]>({
    queryKey: ["events"],
  })) {
    if (!Array.isArray(list)) continue;
    const hit = list.find(
      (e) =>
        e.provider === "ical" &&
        e.accountId === accountId &&
        e.externalId === externalId &&
        (!occurrenceDate || e.date.slice(0, 10) === occurrenceDate),
    );
    if (hit) return hit;
  }
  return undefined;
}

export function useEvent(id: string | null | undefined) {
  const qc = useQueryClient();
  return useQuery<EventDto | null>({
    queryKey: ["event", id],
    queryFn: async () => {
      if (!id) return null;
      const result = await tauriInvoke<EventDto | null>("event_get", { id });
      return result ?? null;
    },
    enabled: !!id,
    // Clicking a schedule row already has the full event sitting in the
    // `["events", <date>]` list cache. Seed the detail view from it so the
    // page paints real content on the first frame instead of flashing a
    // skeleton while `event_get` round-trips. The background refetch
    // returns identical data, so the swap is invisible.
    placeholderData: () => (id ? findEventInLists(qc, id) : undefined),
  });
}

/** iCal event detail: read-only metadata from the gcal-cache, plus any
 *  meeting-notes body saved to `events/<occurrence_id>.md`. The event is
 *  identified by (account_id, external_id), not its synthetic id, so
 *  the page survives a cache miss without us having to materialize
 *  every iCal event into a file at sync time. */
function icalEventQueryKey(
  accountId: string | undefined,
  externalId: string | undefined,
  occurrenceDate?: string,
) {
  return ["event", "ical", accountId, externalId, occurrenceDate ?? null] as const;
}

function icalEventTitleQueryKey(
  accountId: string | undefined,
  externalId: string | undefined,
) {
  return ["event", "ical", accountId, externalId] as const;
}

export function useIcalEvent(
  accountId: string | undefined,
  externalId: string | undefined,
  occurrenceDate?: string,
) {
  const qc = useQueryClient();
  return useQuery<EventDto | null>({
    queryKey: icalEventQueryKey(accountId, externalId, occurrenceDate),
    queryFn: async () => {
      if (!accountId || !externalId) return null;
      const result = await tauriInvoke<EventDto | null>("event_ical_get", {
        accountId,
        externalId,
        occurrenceDate: occurrenceDate ?? null,
      });
      if (result) {
        qc.setQueryData(icalEventTitleQueryKey(accountId, externalId), result);
      }
      return result ?? null;
    },
    enabled: !!accountId && !!externalId,
    // Seed from the schedule list cache so clicking an iCal row paints
    // real content immediately rather than flashing a skeleton while
    // `event_ical_get` round-trips. See `useEvent`'s `placeholderData`.
    placeholderData: () =>
      accountId && externalId
        ? findIcalEventInLists(qc, accountId, externalId, occurrenceDate)
        : undefined,
  });
}

/** Patch an iCal occurrence's local markdown file at
 *  `events/<occurrence_id>.md`. Pass only the fields you want to change
 *  — absent fields preserve whatever the existing overlay (or cache
 *  fallback) had. The gcal cache is never touched; local edits survive
 *  the next sync. */
export function useIcalEventSaveNotes() {
  const qc = useQueryClient();
  return useMutation<
    EventDto,
    Error,
    {
      accountId: string;
      externalId: string;
      body?: string;
      title?: string;
      date?: string;
      duration?: number;
      area?: string;
      occurrenceDate?: string;
    }
  >({
    mutationFn: async ({
      accountId,
      externalId,
      body,
      title,
      date,
      duration,
      area,
      occurrenceDate,
    }) => {
      const saved = await tauriInvoke<EventDto>("event_ical_save_notes", {
        accountId,
        externalId,
        occurrenceDate: occurrenceDate ?? null,
        body: body ?? null,
        title: title ?? null,
        date: date ?? null,
        duration: duration ?? null,
        area: area ?? null,
      });
      if (!saved) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData(
        icalEventQueryKey(accountId, externalId, occurrenceDate),
        saved,
      );
      qc.setQueryData(icalEventTitleQueryKey(accountId, externalId), saved);
      // Update the schedule-block list for the saved event's day so the
      // edited title / time picks up there too.
      const day = saved.date.split("T")[0];
      qc.invalidateQueries({ queryKey: ["events", day] });
      return saved;
    },
  });
}

export function useEventMutations() {
  const qc = useQueryClient();

  const create = useMutation<EventDto, Error, EventCreateInput>({
    mutationFn: async (input) => {
      const created = await tauriInvoke<EventDto>("event_create", {
        input: {
          title: input.title,
          date: input.date,
          duration: input.duration,
          area: input.area,
          attendees: input.attendees ?? [],
          recurring: input.recurring ?? "none",
          subtitle: input.subtitle ?? null,
          tags: input.tags ?? [],
          body: input.body ?? null,
        },
      });
      if (!created) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      // Drop into the bucket for the event's day. Recurrences only show
      // up after a refetch — invalidate the date list to be safe.
      const day = created.date.split("T")[0];
      upsertInList(qc, ["events", day], created);
      qc.setQueryData(["event", created.id], created);
      qc.invalidateQueries({ queryKey: ["events", day] });
      return created;
    },
  });

  const update = useMutation<
    EventDto,
    Error,
    { id: string; update: EventUpdateInput },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ id, update }) => {
      const updated = await tauriInvoke<EventDto>("event_update", {
        id,
        update,
      });
      if (!updated) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData(["event", updated.id], updated);
      // The event may have moved between days (date change) or had its
      // recurrence rule altered, so invalidate every list query.
      qc.invalidateQueries({ queryKey: ["events"] });
      return updated;
    },
    onMutate: async ({ id, update }) => {
      const snapshots = new Map<readonly unknown[], unknown>();

      const prevSingle = qc.getQueryData<EventDto | null>(["event", id]);
      if (prevSingle) {
        snapshots.set(["event", id], prevSingle);
        qc.setQueryData(["event", id], applyOptimisticPatch(prevSingle, update));
      }

      qc.getQueriesData<EventDto[]>({ queryKey: ["events"] }).forEach(
        ([key, value]) => {
          if (!Array.isArray(value)) return;
          const idx = value.findIndex((e) => e.id === id);
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
    { id: string },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ id }) => {
      await tauriInvoke<void>("event_delete", { id });
    },
    onMutate: async ({ id }) => {
      const snapshots = new Map<readonly unknown[], unknown>();

      const prevSingle = qc.getQueryData<EventDto | null>(["event", id]);
      if (prevSingle !== undefined) {
        snapshots.set(["event", id], prevSingle);
        qc.setQueryData(["event", id], null);
      }

      qc.getQueriesData<EventDto[]>({ queryKey: ["events"] }).forEach(
        ([key, value]) => {
          if (!Array.isArray(value)) return;
          const idx = value.findIndex((e) => e.id === id);
          if (idx === -1) return;
          snapshots.set(key, value);
          qc.setQueryData(
            key,
            value.filter((e) => e.id !== id),
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

  return { create, update, remove };
}

function applyOptimisticPatch(event: EventDto, update: EventUpdateInput): EventDto {
  const next: EventDto = { ...event };
  if (update.title !== undefined) next.title = update.title;
  if (update.subtitle !== undefined) {
    next.subtitle = update.subtitle === null ? undefined : update.subtitle;
  }
  if (update.date !== undefined) next.date = update.date;
  if (update.duration !== undefined) next.duration = update.duration;
  if (update.area !== undefined) next.area = update.area;
  if (update.attendees !== undefined) next.attendees = update.attendees;
  if (update.recurring !== undefined) next.recurring = update.recurring;
  if (update.tags !== undefined) next.tags = update.tags;
  if (update.body !== undefined) next.body = update.body;
  return next;
}

function upsertInList(qc: QueryClient, key: readonly unknown[], event: EventDto) {
  const current = qc.getQueryData<EventDto[]>(key);
  if (!current) return;
  const idx = current.findIndex((e) => e.id === event.id);
  const next =
    idx === -1 ? [...current, event] : current.map((e) => (e.id === event.id ? event : e));
  // Sort by absolute instant, not by raw string — iCal events store UTC
  // ("+00:00") while vault-local events carry the local offset, and ICU
  // collation orders "-07:00" before "+00:00", which would float a new
  // afternoon event to the top of the schedule. Mirrors the backend sort
  // in events_for_date.
  next.sort(
    (a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime() ||
      a.date.localeCompare(b.date),
  );
  qc.setQueryData(key, next);
}
