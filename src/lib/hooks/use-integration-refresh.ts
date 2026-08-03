import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";

export const INTEGRATION_REFRESH_INTERVALS = [0, 5, 15, 30, 60] as const;
export type IntegrationRefreshInterval =
  (typeof INTEGRATION_REFRESH_INTERVALS)[number];

export interface IntegrationRefreshSettings {
  /** Zero means Manual. */
  intervalMinutes: IntegrationRefreshInterval;
}

const INTEGRATION_REFRESH_KEY = ["settings", "integration-refresh"] as const;

export function useIntegrationRefreshSettings() {
  return useQuery<IntegrationRefreshSettings>({
    queryKey: INTEGRATION_REFRESH_KEY,
    queryFn: async () =>
      (await tauriInvoke<IntegrationRefreshSettings>(
        "integration_refresh_settings_get",
      )) ?? { intervalMinutes: 5 },
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
