import type { WoodshedClient } from "./types";

export const tauriTransport: WoodshedClient = {
  async invoke<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T | null> {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return null;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  },

  async log(level, target, message): Promise<void> {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("logs_event", { input: { level, target, message } });
    } catch {
      // Intentionally swallow. Logging must never mask the original error.
    }
  },

  subscribeVaultChanges(callback) {
    let unlistenFn: (() => void) | null = null;
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return () => {};
    }

    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("vault:changed", (event) => {
          callback(event.payload as Parameters<typeof callback>[0]);
        }),
      )
      .then((fn) => {
        unlistenFn = fn;
      })
      .catch(() => {
        // Best-effort. If listen fails we just don't get invalidation.
      });

    return () => {
      if (unlistenFn) {
        unlistenFn();
        unlistenFn = null;
      }
    };
  },
};
