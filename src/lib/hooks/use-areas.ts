"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";
import { defaultAreas } from "@/lib/areas";
import type { Area } from "@/lib/types";

export interface SpaceCreateInput {
  name: string;
  color?: string;
}

export interface SpaceUpdateInput {
  name?: string;
  color?: string;
  description?: string;
}

export function useAreas() {
  return useQuery<Area[]>({
    queryKey: ["areas"],
    queryFn: async () => {
      const result = await tauriInvoke<Area[]>("areas_get");
      // Browser-only fallback (vitest, no Tauri runtime). Returns the seeded
      // defaults so the UI still renders consistently in tests.
      return result ?? defaultAreas;
    },
  });
}

export function useAreaMutations() {
  const qc = useQueryClient();

  const create = useMutation<Area, Error, SpaceCreateInput>({
    mutationFn: async (input) => {
      const created = await tauriInvoke<Area>(
        "area_create",
        input as unknown as Record<string, unknown>,
      );
      if (!created) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData<Area[]>(["areas"], (old) =>
        old ? [...old, created] : [created],
      );
      return created;
    },
  });

  const update = useMutation<
    Area,
    Error,
    { id: string; update: SpaceUpdateInput }
  >({
    mutationFn: async ({ id, update }) => {
      const updated = await tauriInvoke<Area>("area_update", { id, update });
      if (!updated) throw new Error("Tauri runtime missing");
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData<Area[]>(["areas"], (old) =>
        old ? old.map((s) => (s.id === updated.id ? updated : s)) : [updated],
      );
      return updated;
    },
  });

  const remove = useMutation<void, Error, { id: string }>({
    mutationFn: async ({ id }) => {
      await tauriInvoke<void>("area_delete", { id });
      // Cache writes inside mutationFn so they survive mid-flight unmount.
      qc.setQueryData<Area[]>(["areas"], (old) =>
        old ? old.filter((s) => s.id !== id) : [],
      );
    },
  });

  return { create, update, remove };
}
