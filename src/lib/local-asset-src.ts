import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/runtime";

export function isLocalFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Convert an absolute filesystem path into a URL the current runtime can load.
 *
 * Tauri uses its asset protocol. Plain browser mode has no safe local file
 * access, so callers should fall back to initials/placeholders.
 */
export function resolveLocalAssetSrc(path: string): string | null {
  if (!isLocalFilePath(path)) return path;
  if (isTauriRuntime()) return convertFileSrc(path);
  return null;
}
