import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";

export interface IntegrationRefreshSettings {
  /** Zero means Manual; other accepted values are 5, 15, 30, or 60. */
  intervalMinutes: number;
}

const INTEGRATION_REFRESH_KEY = ["settings", "integration-refresh"] as const;

export function useIntegrationRefreshSettings() {
  return useQuery<IntegrationRefreshSettings>({
    queryKey: INTEGRATION_REFRESH_KEY,
    queryFn: async () =>
      (await tauriInvoke<IntegrationRefreshSettings>(
        "integration_refresh_settings_get",
      )) ?? { intervalMinutes: 0 },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useSetIntegrationRefreshSettings() {
  const queryClient = useQueryClient();
  return useMutation<
    IntegrationRefreshSettings,
    Error,
    IntegrationRefreshSettings
  >({
    mutationFn: async (settings) => {
      const result = await tauriInvoke<IntegrationRefreshSettings>(
        "integration_refresh_settings_set",
        { settings },
      );
      if (!result) throw new Error("Tauri runtime missing");
      return result;
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(INTEGRATION_REFRESH_KEY, settings);
    },
  });
}
