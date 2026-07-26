import { hasBackend, tauriInvoke } from "@/lib/tauri";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
  "http:",
  "https:",
  "mailto:",
  "tel:",
]);

export function isAllowedExternalUrl(value: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isAllowedExternalUrl(url)) {
    throw new Error("Unsupported external URL");
  }
  if (hasBackend()) {
    await tauriInvoke<void>("external_url_open", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
