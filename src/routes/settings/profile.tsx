import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage, SettingsGroup } from "@/components/settings/settings-page";
import { tauriInvoke } from "@/lib/tauri";

export const Route = createFileRoute("/settings/profile")({
  component: ProfileSettingsPage,
});

interface Profile {
  display_name: string;
  email: string;
  theme: "system" | "light" | "dark";
}

const DEFAULT_PROFILE: Profile = {
  display_name: "",
  email: "",
  theme: "system",
};

function ProfileSettingsPage() {
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [savedFlash, setSavedFlash] = useState<"name" | "email" | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    tauriInvoke<Profile>("profile_get").then((p) => {
      if (p) setProfile(p);
      setLoaded(true);
    });
  }, []);

  async function save(next: Profile, field: "name" | "email") {
    await tauriInvoke<void>("profile_set", { profile: next });
    setSavedFlash(field);
    window.setTimeout(() => setSavedFlash((f) => (f === field ? null : f)), 1500);
  }

  function onBlurDisplayName(e: React.FocusEvent<HTMLInputElement>) {
    const next = { ...profile, display_name: e.target.value.trim() };
    if (next.display_name === profile.display_name) return;
    setProfile(next);
    save(next, "name");
  }

  function onBlurEmail(e: React.FocusEvent<HTMLInputElement>) {
    const next = { ...profile, email: e.target.value.trim() };
    if (next.email === profile.email) return;
    setProfile(next);
    save(next, "email");
  }

  return (
    <SettingsPage section="Profile">
      <SettingsGroup label="Identity">
        <div className="flex flex-col gap-3 max-w-[420px]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="display_name" className="text-[13px] text-muted-foreground">
              Display name
            </label>
            <div className="flex items-center gap-2">
              <input
                id="display_name"
                type="text"
                defaultValue={loaded ? profile.display_name : ""}
                key={`name-${loaded}`}
                onBlur={onBlurDisplayName}
                className="flex-1 h-8 px-3 rounded-sm border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
              />
              <SavedFlash visible={savedFlash === "name"} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-[13px] text-muted-foreground">
              Email
            </label>
            <div className="flex items-center gap-2">
              <input
                id="email"
                type="email"
                defaultValue={loaded ? profile.email : ""}
                key={`email-${loaded}`}
                onBlur={onBlurEmail}
                className="flex-1 h-8 px-3 rounded-sm border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
              />
              <SavedFlash visible={savedFlash === "email"} />
            </div>
          </div>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}

function SavedFlash({ visible }: { visible: boolean }) {
  return (
    <span
      aria-live="polite"
      className={`font-mono text-[12px] text-muted-foreground transition-opacity duration-150 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      Saved
    </span>
  );
}
