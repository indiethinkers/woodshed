import { useState } from "react";
import { SettingsGroup } from "@/components/settings/settings-page";
import {
  useIntegrationRefreshSettings,
  useSetIntegrationRefreshSettings,
} from "@/lib/hooks/use-integration-refresh";

const INTERVALS = [
  { minutes: 0, label: "Manual" },
  { minutes: 5, label: "Every 5 minutes" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
] as const;

export function IntegrationRefreshSettingsSection() {
  const { data: settings, isLoading } = useIntegrationRefreshSettings();
  const setSettings = useSetIntegrationRefreshSettings();
  const [error, setError] = useState<string | null>(null);

  async function updateInterval(intervalMinutes: number) {
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
      description="Optionally refresh connected mail and calendars while Woodshed is running. Manual is the default. Background mail refreshes produce one in-app notice for each new-message batch, without including sender or subject content."
    >
      <div className="flex max-w-[560px] flex-col gap-2">
        <label className="flex items-center justify-between gap-4 rounded-sm border border-border px-3 py-2.5">
          <span className="text-[13px] font-medium text-foreground">
            Refresh mail and calendars
          </span>
          <select
            aria-label="Automatic refresh interval"
            value={settings?.intervalMinutes ?? 0}
            disabled={isLoading || setSettings.isPending}
            onChange={(event) => void updateInterval(Number(event.target.value))}
            className="h-8 rounded-sm border border-border bg-background px-2 text-[12px] text-foreground outline-none focus:ring-2 focus:ring-[var(--focus-ring)] disabled:opacity-50"
          >
            {INTERVALS.map((interval) => (
              <option key={interval.minutes} value={interval.minutes}>
                {interval.label}
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
