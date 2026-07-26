// Deterministic per-inbox color. Hashes the inbox id (or any string) into
// a fixed palette so the unified inbox shows a consistent dot per inbox
// without the user having to configure anything. Future: a persisted
// override map in tauri-plugin-store can take precedence over this.

const PALETTE = [
  "#378ADD", // blue
  "#7F77DD", // violet
  "#1D9E75", // green
  "#D85A30", // coral
  "#E0A93B", // amber
  "#C04E8E", // magenta
  "#3FA8B5", // teal
  "#888780", // stone
];

export function inboxColor(inboxId: string): string {
  if (!inboxId) return PALETTE[PALETTE.length - 1];
  let hash = 0;
  for (let i = 0; i < inboxId.length; i++) {
    // Standard small string hash; result is non-negative after the |0 trick.
    hash = (hash * 31 + inboxId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PALETTE.length;
  return PALETTE[idx];
}
