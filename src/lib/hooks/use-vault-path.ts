import { useQuery } from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";

/**
 * Resolved vault root path (e.g. `/Users/alice/woodshed`). Cached forever
 * — the vault path doesn't change during a session, and any change forces
 * a relaunch anyway. Returns `null` outside Tauri or before the vault is
 * configured (e.g. on /welcome).
 */
export function useVaultPath() {
  return useQuery<string | null>({
    queryKey: ["vaultPath"],
    queryFn: async () => {
      return (await tauriInvoke<string | null>("vault_path_get")) ?? null;
    },
    // Never refetch — this is effectively a constant for the session.
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
