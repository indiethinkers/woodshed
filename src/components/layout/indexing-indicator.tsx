import { useEffect, useState } from "react";

// Small pulsing dot that appears in the sidebar rail while the search index
// is rebuilding. Wired to the Rust-side `index:rebuild:start|done|error`
// events emitted from watcher_start when a cold or post-migration rebuild
// kicks off on a background thread. No UI when no rebuild is active.
export function IndexingIndicator() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return;
    }
    let unlistenStart: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      listen("index:rebuild:start", () => setActive(true)).then((fn) => {
        unlistenStart = fn;
      });
      listen("index:rebuild:done", () => setActive(false)).then((fn) => {
        unlistenDone = fn;
      });
      listen("index:rebuild:error", () => setActive(false)).then((fn) => {
        unlistenError = fn;
      });
    });
    return () => {
      unlistenStart?.();
      unlistenDone?.();
      unlistenError?.();
    };
  }, []);

  if (!active) return null;
  return (
    <div
      className="h-8 w-8 flex items-center justify-center text-muted-foreground"
      title="Rebuilding search index…"
      aria-label="Rebuilding search index"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse" />
    </div>
  );
}
