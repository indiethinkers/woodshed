import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage, SettingsGroup } from "@/components/settings/settings-page";
import { tauriInvoke } from "@/lib/tauri";
import { setThemePreference, type Theme } from "@/lib/theme";

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsPage,
});

interface Profile {
  display_name: string;
  email: string;
  theme: Theme;
}

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppearanceSettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    tauriInvoke<Profile>("profile_get").then((p) => {
      if (p) setProfile(p);
    });
  }, []);

  async function setTheme(theme: Theme) {
    if (!profile) return;
    const next: Profile = { ...profile, theme };
    setProfile(next);
    setThemePreference(theme);
    await tauriInvoke<void>("profile_set", { profile: next });
  }

  return (
    <SettingsPage section="Appearance">
      <SettingsGroup
        label="Theme"
        description="Light and dark are first-class. System follows your macOS appearance setting."
      >
        <div className="inline-flex rounded-sm border border-border p-0.5 bg-muted self-start">
          {THEMES.map((t) => {
            const isActive = profile?.theme === t.value;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => setTheme(t.value)}
                disabled={!profile}
                className={`px-3 h-7 rounded-sm text-[13px] transition-colors ${
                  isActive
                    ? "bg-background text-foreground shadow-[0_0_0_1px_var(--border)]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
