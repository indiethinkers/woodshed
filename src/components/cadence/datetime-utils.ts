// Helpers for combining/splitting the ISO datetime strings stored on
// event records. The vault keeps wall-clock time with an explicit
// offset (e.g. "2026-05-13T08:00:00-04:00") so the local hour an event
// was scheduled at survives round-trips through Rust + display.

/**
 * Combine a YYYY-MM-DD date with an HH:MM time into an ISO datetime
 * with the browser's local timezone offset. Mirrors what the Tauri
 * backend would emit if it constructed the event itself.
 */
export function combineDateTime(date: string, time: string): string {
  const [hh, mm] = time.split(":").map((n) => parseInt(n, 10));
  const d = new Date(`${date}T00:00:00`);
  d.setHours(hh || 0, mm || 0, 0, 0);
  // toISOString() always returns UTC; we want to preserve the local
  // wall-clock time the user entered, with their offset attached.
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMinutes);
  const offH = Math.floor(absMin / 60).toString().padStart(2, "0");
  const offM = (absMin % 60).toString().padStart(2, "0");
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${offH}:${offM}`
  );
}

/** Pull YYYY-MM-DD out of an ISO datetime, in the browser's local zone. */
export function localDatePart(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Pull HH:MM (24h) out of an ISO datetime, in the browser's local zone. */
export function localTimePart(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
