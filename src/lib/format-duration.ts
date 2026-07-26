/**
 * Format a non-negative duration in seconds as a compact, human-readable
 * string. Examples:
 *
 *   formatDuration(0)      => "0s"
 *   formatDuration(45)     => "45s"
 *   formatDuration(90)     => "1m 30s"
 *   formatDuration(3600)   => "1h"
 *   formatDuration(3725)   => "1h 2m"
 *   formatDuration(90061)  => "1d 1h"
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const s = Math.floor(seconds);

  if (s < 60) return `${s}s`;

  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }

  const h = Math.floor(m / 60);
  if (h < 24) {
    const remM = m % 60;
    return remM ? `${h}h ${remM}m` : `${h}h`;
  }

  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

/**
 * Compute the current "live" time spent for a task, including any active
 * in-progress run. If `startedAt` is set, includes (now - startedAt) on top
 * of the accumulated total.
 */
export function liveTimeSpent(
  accumulatedSeconds: number,
  startedAt: string | undefined,
  now: Date = new Date(),
): number {
  if (!startedAt) return accumulatedSeconds;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return accumulatedSeconds;
  const liveDelta = Math.max(0, Math.floor((now.getTime() - started) / 1000));
  return accumulatedSeconds + liveDelta;
}
