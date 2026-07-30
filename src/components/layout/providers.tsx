import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ListPanelProvider } from "@/components/layout/list-panel-context";
import { AgentPanelProvider } from "@/components/layout/agent-panel-context";
import { RightSidebarProvider } from "@/components/layout/right-sidebar-context";
import { TabsProvider } from "@/components/layout/tabs-context";
import { RouteTheme } from "@/components/layout/route-theme";
import { Toaster } from "@/components/layout/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  invalidateAfterIndexRebuild,
  vaultEventListener,
} from "@/lib/vault-events";
import { logsEvent } from "@/lib/tauri";
import { WikilinkTargetsBridge } from "@/lib/hooks/wikilink-targets-bridge";
import { MailRefreshProvider } from "@/lib/hooks/use-mail-refresh-job";
import { DemoClockProvider } from "@/lib/demo-clock";

// Single QueryClient per app. staleTime: Infinity because cache invalidation
// is event-driven via the Tauri vault:changed listener, not polling.
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Populated data stays event-driven (refetch only on a vault:changed
        // invalidation) — that's the whole point of the file-watcher model.
        // BUT an EMPTY array result must not be trusted forever: a transient
        // backend hiccup can resolve a list query to [] (a *success*, not an
        // error), and under a flat staleTime: Infinity that bogus empty is
        // "fresh" permanently — nothing refetches it, not even remounting the
        // surface. That's how the Notebook (and any record list) goes blank
        // and stays blank. Treating an empty collection as immediately stale
        // makes the next mount revalidate it, so a spurious empty self-heals
        // the moment the user navigates back. Non-empty data and single-record
        // (non-array) queries keep Infinity.
        staleTime: (query) => {
          const data = query.state.data;
          return Array.isArray(data) && data.length === 0 ? 0 : Infinity;
        },
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // The desktop IPC can transiently refuse a request during a restart,
        // a startup race, or while a long-lived agent stream holds the
        // channel. Retry a few times with backoff so those transients
        // self-heal instead of leaving an errored query parked under the
        // staleTime rule above.
        retry: 3,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  useEffect(() => {
    const unsubscribe = vaultEventListener(queryClient);
    return () => {
      unsubscribe();
    };
  }, [queryClient]);

  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return;
    }
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      listen("index:rebuild:done", () => {
        invalidateAfterIndexRebuild(queryClient);
      }).then((fn) => {
        unlisten = fn;
      });
    });
    return () => unlisten?.();
  }, [queryClient]);

  // Global JS error capture. React error boundaries only catch errors
  // thrown during render; this picks up everything else — unhandled
  // promise rejections, errors in async event handlers, errors fired
  // outside React entirely. The Rust log file becomes the single
  // place to look when something went wrong.
  useEffect(() => {
    function onError(event: ErrorEvent) {
      const msg = event.error?.stack ?? event.message ?? "(no message)";
      // eslint-disable-next-line no-console
      console.error("[woodshed] window error:", event.error ?? event.message);
      void logsEvent(
        "error",
        "window-error",
        `${event.filename}:${event.lineno}:${event.colno} ${msg}`,
      );
    }
    function onUnhandledRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      const msg =
        reason instanceof Error
          ? (reason.stack ?? reason.message)
          : String(reason);
      // eslint-disable-next-line no-console
      console.error("[woodshed] unhandled rejection:", reason);
      void logsEvent("error", "unhandled-rejection", msg);
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <DemoClockProvider>
        <MailRefreshProvider>
          <WikilinkTargetsBridge />
          <TooltipProvider>
            <AgentPanelProvider>
              <RightSidebarProvider>
                <TabsProvider>
                  <ListPanelProvider>
                    <RouteTheme>{children}</RouteTheme>
                  </ListPanelProvider>
                </TabsProvider>
              </RightSidebarProvider>
            </AgentPanelProvider>
          </TooltipProvider>
        </MailRefreshProvider>
      </DemoClockProvider>
      <Toaster />
    </QueryClientProvider>
  );
}
