/** Resolve the cadence day a sidebar surface should show. */
export function extractDate(pathname: string): string | null {
  const match = pathname.match(/^\/cadence\/([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  return match ? match[1] : null;
}

export function resolveSidebarDate(
  pathname: string,
  fallbackDate: string,
  contextDate?: string | null,
): string {
  return extractDate(pathname) ?? contextDate ?? fallbackDate;
}

export function formatScheduleDayLabel(dateStr: string, today: string): string {
  if (dateStr === today) return "today";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
