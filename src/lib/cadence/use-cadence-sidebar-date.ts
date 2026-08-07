import { useRouterState } from "@tanstack/react-router";
import { resolveSidebarDate } from "@/lib/cadence/sidebar-date";
import { useEvent, useIcalEvent } from "@/lib/hooks/use-events";
import { useToday } from "@/lib/hooks/use-today";

/** Day the cadence sidebar (tasks + schedule) should track for the current route. */
export function useCadenceSidebarDate(): string {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const today = useToday();

  const vaultEventMatch = pathname.match(/^\/cadence\/event\/([^/]+)$/);
  const icalMatch = pathname.match(
    /^\/cadence\/event\/ical\/([^/]+)\/([^/]+)$/,
  );

  const vaultEventId = vaultEventMatch?.[1];
  const { data: vaultEvent } = useEvent(vaultEventId);

  const accountId = icalMatch?.[1];
  const externalId = icalMatch?.[2];
  const { data: icalEvent } = useIcalEvent(accountId, externalId);

  const contextDate =
    vaultEvent?.date.slice(0, 10) ?? icalEvent?.date.slice(0, 10) ?? null;

  return resolveSidebarDate(pathname, today, contextDate);
}
