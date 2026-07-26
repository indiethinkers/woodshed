import { useEffect, useState } from "react";
import { tauriInvoke } from "@/lib/tauri";

// Persistent dismissible banner pattern (per /plan-design-review D4 ruling).
// Used for: iCloud-active warning, watcher-disconnected. Re-shows on next
// /settings visit if the underlying condition is still true.

type WarningKey = "icloud-active" | "watcher-disconnected";

interface ActiveWarning {
  key: WarningKey;
  message: string;
}

export function WarningBanner() {
  const [warnings, setWarnings] = useState<ActiveWarning[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const candidates: ActiveWarning[] = [];

      // iCloud-active check
      const vaultPath = await tauriInvoke<string | null>("vault_path_get");
      if (vaultPath) {
        const isIcloud = await tauriInvoke<boolean>("vault_is_icloud", {
          path: vaultPath,
        });
        if (isIcloud) {
          const dismissed = await tauriInvoke<boolean>("warning_dismissed_get", {
            key: "icloud-active",
          });
          if (!dismissed) {
            candidates.push({
              key: "icloud-active",
              message:
                "Vault is in iCloud Drive. File writes use direct-write fallback (slightly less crash-safe than the default temp+rename). Move the vault out of iCloud Drive if this matters to you.",
            });
          }
        }
      }

      if (!cancelled) setWarnings(candidates);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function dismiss(key: WarningKey) {
    await tauriInvoke<void>("warning_dismiss", { key });
    setWarnings((w) => w.filter((x) => x.key !== key));
  }

  if (warnings.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 mb-6">
      {warnings.map((w) => (
        <div
          key={w.key}
          role="status"
          className="flex items-start justify-between gap-4 px-4 py-3 border border-border rounded-sm bg-muted"
        >
          <p className="font-mono text-[13px] leading-[1.5] text-foreground">
            {w.message}
          </p>
          <button
            type="button"
            onClick={() => dismiss(w.key)}
            className="shrink-0 text-[12px] text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
