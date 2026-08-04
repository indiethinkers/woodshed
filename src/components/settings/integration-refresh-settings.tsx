import { useState } from "react";
import { SettingsGroup } from "@/components/settings/settings-page";
import {
  INTEGRATION_REFRESH_INTERVALS,
  type IntegrationRefreshInterval,
  useIntegrationRefreshSettings,
  useSetIntegrationRefreshSettings,
} from "@/lib/hooks/use-integration-refresh";

const INTERVAL_LABELS: Record<IntegrationRefreshInterval, string> = {
  0: "Manual",
  5: "Every 5 minutes",
  15: "Every 15 minutes",
  30: "Every 30 minutes",
  60: "Every hour",
};

export function IntegrationRefreshSettingsSection() {
  const { data: settings, isLoading } = useIntegrationRefreshSettings();
  const setSettings = useSetIntegrationRefreshSettings();
  const [error, setError] = useState<string | null>(null);

  async function updateInterval(intervalMinutes: IntegrationRefreshInterval) {
    setError(null);
    try {
      await setSettings.mutateAsync({ intervalMinutes });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <SettingsGroup
      label="Automatic refresh"
      description="Refresh connected mail and calendars every 5 minutes by default while Woodshed is running. You can choose Manual to disable automatic refresh. Background mail refreshes produce one in-app notice for each new-message batch, without including sender or subject content."
    >
      <div className="flex max-w-[560px] flex-col gap-2">
        <label className="flex items-center justify-between gap-4 rounded-sm border border-border px-3 py-2.5">
          <span className="text-[13px] font-medium text-foreground">
            Refresh mail and calendars
          </span>
          <select
            aria-label="Automatic refresh interval"
            value={settings?.intervalMinutes ?? 5}
            disabled={isLoading || setSettings.isPending}
            onChange={(event) =>
              void updateInterval(
                Number(event.target.value) as IntegrationRefreshInterval,
              )
            }
            className="h-8 rounded-sm border border-border bg-background px-2 text-[12px] text-foreground outline-none focus:ring-2 focus:ring-[var(--focus-ring)] disabled:opacity-50"
          >
            {INTEGRATION_REFRESH_INTERVALS.map((interval) => (
              <option key={interval} value={interval}>
                {INTERVAL_LABELS[interval]}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          This is foreground polling, not push: Woodshed catches up when the
          app regains focus, but does not refresh after the app quits.
        </p>
        {error && (
          <p className="font-mono text-[11px] text-red-500">{error}</p>
        )}
      </div>
    </SettingsGroup>
  );
}
