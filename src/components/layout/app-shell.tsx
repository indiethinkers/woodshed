import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "@/components/layout/sidebar";
import { AgentSidebarPanel } from "@/components/layout/agent-sidebar-panel";
import { useAgentPanel } from "@/components/layout/agent-panel-context-internal";
import { isAgentFocusMode } from "@/components/layout/agent-panel-route";
import { RightSidebarPanel } from "@/components/layout/right-sidebar-panel";
import { TitleBar } from "@/components/layout/title-bar";
import { IntegrationRefreshScheduler } from "@/components/layout/integration-refresh-scheduler";
import { CommandPalette } from "@/components/shared/command-palette";
import { tauriInvoke, hasBackend } from "@/lib/tauri";
import { clearSystemThemeWatcher, setThemePreference } from "@/lib/theme";

interface Profile {
  display_name: string;
  email: string;
  theme: "system" | "light" | "dark";
}

// Decides whether to wrap children in the standard 3-panel app shell
// (sidebar + main + command palette) or render them full-screen.
// /welcome is the only route that takes over the window.
//
// Also handles app-start side effects:
//   - If vault path is unset, redirect to /welcome.
//   - Apply the user's stored theme on first paint and keep "system" synced
//     with macOS appearance changes.
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { open: agentPanelOpen } = useAgentPanel();
  const checkedVault = useRef(false);
  const [watcherReady, setWatcherReady] = useState(false);

  const isFullScreen = pathname.startsWith("/welcome");
  const agentFocusMode = isAgentFocusMode(pathname, agentPanelOpen);

  useEffect(() => {
    let cancelled = false;

    if (!hasBackend()) {
      setThemePreference("system");
      return () => {
        clearSystemThemeWatcher();
      };
    }

    tauriInvoke<Profile>("profile_get")
      .then((profile) => {
        if (cancelled) return;
        setThemePreference(profile?.theme ?? "system");
      })
      .catch(() => {
        if (!cancelled) setThemePreference("system");
      });

    return () => {
      cancelled = true;
      clearSystemThemeWatcher();
    };
  }, []);

  useEffect(() => {
    if (!hasBackend()) return;
    if (checkedVault.current) return;
    checkedVault.current = true;

    tauriInvoke<string | null>("vault_path_get").then((vaultPath) => {
      queryClient.setQueryData(["vaultPath"], vaultPath ?? null);
      if (!vaultPath) {
        if (!isFullScreen) {
          void navigate({ to: "/welcome", replace: true });
        }
        return;
      }
      // Vault is configured — boot the filesystem watcher so external edits
      // surface in the UI within the 500ms latency budget. watcher_start is
      // idempotent: re-calls while a watcher is running are no-ops.
      //
      // watcher_start hydrates events_cache / ical_cache / people_email_index
      // synchronously. Tauri runs each command on its own task, so any
      // events_for_date call that fires alongside the initial render races
      // against this hydration and can settle with an empty result (e.g.
      // today's ScheduleBlock showing "No events scheduled today"). Once
      // hydration is done, refetch the events queries so the cached empty
      // result is replaced.
      tauriInvoke<void>("watcher_start", { vaultPath })
        .then(() => {
          setWatcherReady(true);
          queryClient.invalidateQueries({ queryKey: ["events"] });
        })
        .catch(() => {
          // Best-effort: if the watcher fails to start, the user can re-scan
          // manually from /settings/vault.
        });
    });
  }, [navigate, isFullScreen, queryClient]);

  if (isFullScreen) {
    return <>{children}</>;
  }

  return (
    <>
      {watcherReady && <IntegrationRefreshScheduler />}
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar visuallyHidden={agentFocusMode} mailReady={watcherReady} />
        <main className="flex-1 flex overflow-hidden">
          <AgentSidebarPanel />
          {children}
          <RightSidebarPanel />
        </main>
      </div>
      <CommandPalette />
    </>
  );
}
