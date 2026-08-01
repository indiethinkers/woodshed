import { useEffect, useState, type ReactNode } from "react";
import {
  Moon,
  PanelRight,
  RefreshCw,
  Search,
  Sun,
} from "lucide-react";
import { toast } from "sonner";
import { useRightSidebar } from "@/components/layout/right-sidebar-context-internal";
import { useGcalSync } from "@/lib/hooks/use-gcal";
import { useRefreshMail } from "@/lib/hooks/use-mail";
import { setThemePreference } from "@/lib/theme";
import { hasBackend, tauriInvoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface Profile {
  display_name: string;
  email: string;
  theme: "system" | "light" | "dark";
}

interface VaultGitSyncResult {
  summary: string;
  pulledPaths: number;
  pulledFiles: string[];
}

// How many pulled file paths to list before collapsing the rest into a count.
const PULLED_FILES_PREVIEW = 6;

// The sync toast leads with the summary line and, when the pull brought files
// down from GitHub, lists them so the user can see exactly what landed.
function syncToastDescription(result: VaultGitSyncResult | null): ReactNode {
  const summary = result?.summary ?? "Git sync completed.";
  const files = result?.pulledFiles ?? [];
  if (files.length === 0) return summary;
  const shown = files.slice(0, PULLED_FILES_PREVIEW);
  const remaining = files.length - shown.length;
  return (
    <div className="space-y-1.5">
      <div>{summary}</div>
      <ul className="space-y-0.5">
        {shown.map((file) => (
          <li
            className="truncate font-mono text-[11px] opacity-80"
            key={file}
            title={file}
          >
            {file}
          </li>
        ))}
        {remaining > 0 && (
          <li className="text-[11px] opacity-70">+{remaining} more</li>
        )}
      </ul>
    </div>
  );
}

interface IconButtonProps {
  className?: string;
  iconClassName?: string;
}

const titleBarIconButtonClass =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground";

// Right-side title-bar actions: a command-palette search field plus
// quick sync/theme/reference controls. The search field opens the same global
// palette as ⌘K; it is presentation chrome, not a separate input.
export function TitleBarActions({ compact = false }: { compact?: boolean }) {
  return (
    <div
      data-tauri-drag-region="false"
      className={`flex shrink-0 items-center gap-2 ${
        compact ? "w-full px-3" : "pr-4"
      }`}
    >
      <SearchTrigger compact={compact} />
      <WoodshedRefreshButton />
      <ThemeToggle />
      <ReferencesButton />
    </div>
  );
}

function SearchTrigger({ compact = false }: { compact?: boolean }) {
  return (
    <>
      <button
        data-tauri-drag-region="false"
        type="button"
        onClick={() =>
          window.dispatchEvent(new Event("woodshed:open-palette"))
        }
        title="Search (⌘K)"
        aria-label="Search or jump"
        className={`hidden h-8 items-center gap-2 rounded-md border border-[hsl(0_0%_86%)] bg-[hsl(0_0%_96%)] px-3 text-sm text-muted-foreground shadow-[0_1px_1px_hsl(0_0%_0%/0.035)] transition-colors hover:bg-[hsl(0_0%_94%)] hover:text-foreground dark:border-border dark:bg-content/70 dark:hover:bg-content lg:inline-flex ${
          compact ? "min-w-0 flex-1" : "min-w-[240px] max-w-[26vw]"
        }`}
      >
        <Search className="h-4 w-4 shrink-0" strokeWidth={1.85} />
        <span className="min-w-0 flex-1 truncate text-left">
          Search or jump to...
        </span>
        <kbd className="inline-flex h-5 min-w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background/70 px-1.5 font-sans text-[11px] font-medium leading-none text-muted-foreground">
          ⌘K
        </kbd>
      </button>
      <button
        data-tauri-drag-region="false"
        type="button"
        onClick={() =>
          window.dispatchEvent(new Event("woodshed:open-palette"))
        }
        title="Search (⌘K)"
        aria-label="Search or jump"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground lg:hidden"
      >
        <Search className="h-4 w-4" strokeWidth={1.85} />
      </button>
    </>
  );
}

function ReferencesButton() {
  const { open, toggleSidebar } = useRightSidebar();

  return (
    <button
      data-tauri-drag-region="false"
      type="button"
      onClick={toggleSidebar}
      title={open ? "Close right sidebar (⌘/)" : "Open right sidebar (⌘/)"}
      aria-label={open ? "Close right sidebar" : "Open right sidebar"}
      aria-pressed={open}
      className={cn(
        titleBarIconButtonClass,
        open && "bg-foreground/[0.07] text-foreground",
      )}
    >
      <PanelRight className="h-4 w-4" strokeWidth={1.85} />
    </button>
  );
}

export function ThemeToggle({
  className,
  iconClassName,
}: IconButtonProps = {}) {
  // Mirror the document class so the icon stays in sync with whatever
  // setThemePreference last wrote (including system-pref changes).
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    setIsDark(root.classList.contains("dark"));
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains("dark"));
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  async function toggle() {
    const next: Profile["theme"] = isDark ? "light" : "dark";
    setThemePreference(next);
    if (!hasBackend()) return;
    try {
      const profile = await tauriInvoke<Profile>("profile_get");
      if (!profile) return;
      await tauriInvoke<void>("profile_set", {
        profile: { ...profile, theme: next },
      });
    } catch {
      // Best-effort persistence; the theme is already applied to the DOM.
    }
  }

  return (
    <button
      data-tauri-drag-region="false"
      type="button"
      onClick={toggle}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={cn(titleBarIconButtonClass, className)}
    >
      {isDark ? (
        <Sun className={cn("h-4 w-4", iconClassName)} strokeWidth={1.85} />
      ) : (
        <Moon className={cn("h-4 w-4", iconClassName)} strokeWidth={1.85} />
      )}
    </button>
  );
}

export function WoodshedRefreshButton({
  className,
  iconClassName,
}: IconButtonProps = {}) {
  const [isSyncing, setIsSyncing] = useState(false);
  const calendarSync = useGcalSync();
  const refreshMail = useRefreshMail();
  const backendAvailable = hasBackend();

  async function refreshAll() {
    if (isSyncing || !backendAvailable) return;
    setIsSyncing(true);
    const toastId = toast.loading("Refreshing vault, calendars, and mail...");

    try {
      // Git and mail both write vault files, so finish the Git operation before
      // refreshing external accounts. Calendar and mail can then run together.
      const [vaultResult] = await Promise.allSettled([
        tauriInvoke<VaultGitSyncResult>("vault_git_sync"),
      ]);
      const [calendarResult, mailResult] = await Promise.allSettled([
        calendarSync.mutateAsync(),
        refreshMail(),
      ]);

      const failures: string[] = [];
      if (vaultResult.status === "rejected") {
        failures.push(`Vault: ${errorMessage(vaultResult.reason)}`);
      }
      if (calendarResult.status === "rejected") {
        failures.push(`Calendars: ${errorMessage(calendarResult.reason)}`);
      } else {
        const failedAccounts = calendarResult.value.accounts.filter(
          (account) => account.error,
        ).length;
        if (failedAccounts > 0) {
          failures.push(
            `Calendars: ${failedAccounts} account${failedAccounts === 1 ? "" : "s"} failed to refresh.`,
          );
        }
      }
      if (mailResult.status === "rejected") {
        failures.push(`Mail: ${errorMessage(mailResult.reason)}`);
      } else if (mailResult.value.failedAccounts) {
        const failedAccounts = mailResult.value.failedAccounts;
        failures.push(
          `Mail: ${failedAccounts} account${failedAccounts === 1 ? "" : "s"} failed to refresh.`,
        );
      }

      if (failures.length > 0) {
        toast.error("Woodshed refresh incomplete", {
          id: toastId,
          description: failures.join(" "),
        });
      } else {
        toast.success("Woodshed refreshed", {
          id: toastId,
          description: syncToastDescription(
            vaultResult.status === "fulfilled" ? vaultResult.value : null,
          ),
        });
      }
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <button
      data-tauri-drag-region="false"
      type="button"
      onClick={() => void refreshAll()}
      title={
        backendAvailable
          ? "Refresh vault, calendars, and mail"
          : "Refresh requires the Woodshed backend"
      }
      aria-label="Refresh vault, calendars, and mail"
      disabled={!backendAvailable || isSyncing}
      className={cn(
        titleBarIconButtonClass,
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <RefreshCw
        className={cn("h-4 w-4", isSyncing && "animate-spin", iconClassName)}
        strokeWidth={1.85}
      />
    </button>
  );
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 220 ? `${message.slice(0, 217)}...` : message;
}
