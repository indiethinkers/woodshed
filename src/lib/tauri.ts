import { hasWoodshedBackend, isTauriRuntime } from "@/lib/runtime";
import { woodshedClient } from "@/lib/woodshed-client";

export function isTauri(): boolean {
  return isTauriRuntime();
}

export function hasBackend(): boolean {
  return hasWoodshedBackend();
}

export async function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!hasBackend()) {
    return null;
  }
  try {
    return await woodshedClient().invoke<T>(cmd, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[woodshed] ${cmd} failed:`, err);
    // Fire-and-forget; logging must never mask the original error.
    void logsEvent("error", "woodshed-invoke", `${cmd} failed: ${message}`);
    throw err;
  }
}

/**
 * Persist a structured log entry to the Rust log file. Safe to call
 * from anywhere on the frontend; gracefully no-ops outside the Tauri
 * shell. Never throws — failing to log must not become a crash source.
 */
export async function logsEvent(
  level: "info" | "warn" | "error",
  target: string,
  message: string,
): Promise<void> {
  if (!hasBackend()) return;
  await woodshedClient().log(level, target, message);
}
