"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";
import type { TaskStatus, AreaId } from "@/lib/types";

export interface TaskDto {
  id: string;
  path: string;
  content: string;
  status: TaskStatus;
  area: AreaId;
  created?: string;
  scheduled?: string;
  tags: string[];
  /** Total seconds spent in the in-progress state. Defaults to 0. */
  timeSpentSeconds: number;
  /** ISO timestamp for a running timer; absent when inactive or paused. */
  inProgressStartedAt?: string;
  /** Manual sort key for backlog ordering. Always populated; backend falls
   *  back to the created timestamp when no manual key has been set. */
  sortKey: number;
  body: string;
}

export interface TaskCreateInput {
  content: string;
  area: AreaId;
  scheduled?: string;
}

export interface TaskUpdateInput {
  content?: string;
  body?: string;
  status?: TaskStatus;
  area?: AreaId;
  /** Use null to clear the scheduled date; undefined leaves it alone. */
  scheduled?: string | null;
  tags?: string[];
}

const STATUS_RANK: Record<TaskStatus, number> = {
  "in-progress": 0,
  backlog: 1,
  done: 2,
};

function sortByStatus(a: TaskDto, b: TaskDto): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status];
}

export function useTasks(date: string) {
  return useQuery<TaskDto[]>({
    queryKey: ["tasks", date],
    queryFn: async () => {
      const result = await tauriInvoke<TaskDto[]>("tasks_for_date", { date });
      return result ?? [];
    },
    enabled: !!date,
  });
}

export function useAllTasks() {
  return useQuery<TaskDto[]>({
    queryKey: ["tasks"],
    queryFn: async () => {
      const result = await tauriInvoke<TaskDto[]>("tasks_all");
      return result ?? [];
    },
  });
}

export function useTask(id: string | null | undefined) {
  return useQuery<TaskDto | null>({
    queryKey: ["task", id],
    queryFn: async () => {
      if (!id) return null;
      const result = await tauriInvoke<TaskDto | null>("task_get", { id });
      return result ?? null;
    },
    enabled: !!id,
  });
}

export function useTaskMutations() {
  const qc = useQueryClient();

  const create = useMutation<TaskDto, Error, TaskCreateInput>({
    mutationFn: async (input) => {
      const created = await tauriInvoke<TaskDto>("task_create", {
        content: input.content,
        area: input.area,
        scheduled: input.scheduled ?? null,
      });
      if (!created) {
        throw new Error("Tauri runtime missing");
      }
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      // Drop the new task into the relevant date bucket, plus the
      // all-tasks table view, without waiting for a refetch.
      if (created.scheduled) {
        upsertInList(qc, ["tasks", created.scheduled], created);
      }
      upsertInList(qc, ["tasks"], created);
      qc.setQueryData(["task", created.id], created);
      return created;
    },
  });

  const update = useMutation<
    TaskDto,
    Error,
    { id: string; update: TaskUpdateInput },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ id, update }) => {
      const updated = await tauriInvoke<TaskDto>("task_update", { id, update });
      if (!updated) {
        throw new Error("Tauri runtime missing");
      }
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData(["task", updated.id], updated);
      // Replace the task in any list query (covers scheduled-date changes:
      // task may have moved buckets).
      qc.invalidateQueries({ queryKey: ["tasks"] });
      return updated;
    },
    // Optimistic patch: status / content changes show instantly.
    onMutate: async ({ id, update }) => {
      const snapshots = new Map<readonly unknown[], unknown>();

      const prevSingle = qc.getQueryData<TaskDto | null>(["task", id]);
      if (prevSingle) {
        snapshots.set(["task", id], prevSingle);
        const next = applyOptimisticPatch(prevSingle, update);
        qc.setQueryData(["task", id], next);
      }

      // Patch any list query that currently contains this task
      qc.getQueriesData<TaskDto[]>({ queryKey: ["tasks"] }).forEach(
        ([key, value]) => {
          if (!Array.isArray(value)) return;
          const idx = value.findIndex((t) => t.id === id);
          if (idx === -1) return;
          snapshots.set(key, value);
          const next = [...value];
          next[idx] = applyOptimisticPatch(value[idx], update);
          next.sort(sortByStatus);
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

  const pauseTimer = useMutation<
    TaskDto,
    Error,
    { id: string },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ id }) => {
      const updated = await tauriInvoke<TaskDto>("task_timer_pause", { id });
      if (!updated) {
        throw new Error("Tauri runtime missing");
      }
      qc.setQueryData(["task", updated.id], updated);
      qc.invalidateQueries({ queryKey: ["tasks"] });
      return updated;
    },
    onMutate: async ({ id }) => {
      return patchTaskEverywhere(qc, id, pauseTaskOptimistically);
    },
    onError: (_err, _vars, context) => {
      restoreSnapshots(qc, context?.snapshots);
    },
  });

  const resumeTimer = useMutation<
    TaskDto,
    Error,
    { id: string },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ id }) => {
      const updated = await tauriInvoke<TaskDto>("task_timer_resume", { id });
      if (!updated) {
        throw new Error("Tauri runtime missing");
      }
      qc.setQueryData(["task", updated.id], updated);
      qc.invalidateQueries({ queryKey: ["tasks"] });
      return updated;
    },
    onMutate: async ({ id }) => {
      const now = new Date().toISOString();
      return patchTaskEverywhere(qc, id, (task) => ({
        ...task,
        status: "in-progress",
        inProgressStartedAt: task.inProgressStartedAt ?? now,
      }));
    },
    onError: (_err, _vars, context) => {
      restoreSnapshots(qc, context?.snapshots);
    },
  });

  const reorder = useMutation<
    TaskDto,
    Error,
    { id: string; sortKey: number },
    { snapshots: Map<readonly unknown[], unknown> }
  >({
    mutationFn: async ({ id, sortKey }) => {
      const updated = await tauriInvoke<TaskDto>("task_reorder", {
        id,
        sortKey,
      });
      if (!updated) {
        throw new Error("Tauri runtime missing");
      }
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData(["task", updated.id], updated);
      return updated;
    },
    onMutate: async ({ id, sortKey }) => {
      const snapshots = new Map<readonly unknown[], unknown>();

      const prevSingle = qc.getQueryData<TaskDto | null>(["task", id]);
      if (prevSingle) {
        snapshots.set(["task", id], prevSingle);
        qc.setQueryData(["task", id], { ...prevSingle, sortKey });
      }

      qc.getQueriesData<TaskDto[]>({ queryKey: ["tasks"] }).forEach(
        ([key, value]) => {
          if (!Array.isArray(value)) return;
          const idx = value.findIndex((t) => t.id === id);
          if (idx === -1) return;
          snapshots.set(key, value);
          const next = [...value];
          next[idx] = { ...value[idx], sortKey };
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
      await tauriInvoke<void>("task_delete", { id });
      // Drop the single-task cache entry now that the file is gone.
      // The detail-page caller is expected to navigate away in its
      // own onSuccess handler before this matters.
      qc.removeQueries({ queryKey: ["task", id] });
    },
    onMutate: async ({ id }) => {
      // Drop the row from every cached list so the sidebar updates
      // immediately. We deliberately do NOT null out the single-task
      // cache (`["task", id]`) — the detail view caller is responsible
      // for navigating away on success. Nulling here caused the editor
      // to flash "Task not found." in the brief window between mutate
      // and the success-handler's navigate, and stuck on that state
      // when the delete actually failed.
      const snapshots = new Map<readonly unknown[], unknown>();

      qc.getQueriesData<TaskDto[]>({ queryKey: ["tasks"] }).forEach(
        ([key, value]) => {
          if (!Array.isArray(value)) return;
          const idx = value.findIndex((t) => t.id === id);
          if (idx === -1) return;
          snapshots.set(key, value);
          qc.setQueryData(
            key,
            value.filter((t) => t.id !== id),
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

  return { create, update, pauseTimer, resumeTimer, reorder, remove };
}

function patchTaskEverywhere(
  qc: QueryClient,
  id: string,
  patch: (task: TaskDto) => TaskDto,
): { snapshots: Map<readonly unknown[], unknown> } {
  const snapshots = new Map<readonly unknown[], unknown>();

  const prevSingle = qc.getQueryData<TaskDto | null>(["task", id]);
  if (prevSingle) {
    snapshots.set(["task", id], prevSingle);
    qc.setQueryData(["task", id], patch(prevSingle));
  }

  qc.getQueriesData<TaskDto[]>({ queryKey: ["tasks"] }).forEach(
    ([key, value]) => {
      if (!Array.isArray(value)) return;
      const idx = value.findIndex((t) => t.id === id);
      if (idx === -1) return;
      snapshots.set(key, value);
      const next = [...value];
      next[idx] = patch(value[idx]);
      next.sort(sortByStatus);
      qc.setQueryData(key, next);
    },
  );

  return { snapshots };
}

function restoreSnapshots(
  qc: QueryClient,
  snapshots: Map<readonly unknown[], unknown> | undefined,
) {
  if (!snapshots) return;
  for (const [key, value] of snapshots.entries()) {
    qc.setQueryData(key, value);
  }
}

function pauseTaskOptimistically(task: TaskDto): TaskDto {
  if (task.status !== "in-progress" || !task.inProgressStartedAt) {
    return { ...task, inProgressStartedAt: undefined };
  }
  const started = Date.parse(task.inProgressStartedAt);
  const elapsed = Number.isFinite(started)
    ? Math.max(0, Math.floor((Date.now() - started) / 1000))
    : 0;
  return {
    ...task,
    timeSpentSeconds: task.timeSpentSeconds + elapsed,
    inProgressStartedAt: undefined,
  };
}

function applyOptimisticPatch(task: TaskDto, update: TaskUpdateInput): TaskDto {
  const next: TaskDto = { ...task };
  if (update.content !== undefined) next.content = update.content;
  if (update.body !== undefined) next.body = update.body;
  if (update.status !== undefined) next.status = update.status;
  if (update.area !== undefined) next.area = update.area;
  if (update.scheduled !== undefined) {
    next.scheduled = update.scheduled === null ? undefined : update.scheduled;
  }
  if (update.tags !== undefined) next.tags = update.tags;
  return next;
}

function upsertInList(qc: QueryClient, key: readonly unknown[], task: TaskDto) {
  const current = qc.getQueryData<TaskDto[]>(key);
  if (!current) return;
  const idx = current.findIndex((t) => t.id === task.id);
  const next = idx === -1 ? [task, ...current] : current.map((t) => (t.id === task.id ? task : t));
  next.sort(sortByStatus);
  qc.setQueryData(key, next);
}
