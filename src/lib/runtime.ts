export type WoodshedRuntime = "tauri" | "browser";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function runtime(): WoodshedRuntime {
  if (isTauriRuntime()) {
    return "tauri";
  }
  return "browser";
}

export function hasWoodshedBackend(): boolean {
  return runtime() === "tauri";
}
