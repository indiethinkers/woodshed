import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { IcalEventDetail } from "@/components/cadence/ical-event-detail";
import { useIcalEvent } from "@/lib/hooks/use-events";

// iCal event detail: read-only metadata from the gcal-cache + an
// editable meeting-notes body. The occurrence file lands at
// events/<occurrence_id>.md when the date is visited/saved.
// The page is parameterized by (account, externalId) so it works even
// when no notes file exists yet (the cache is the source of truth).
//
// The optional `?date=YYYY-MM-DD` search param carries the projected
// occurrence date for recurring events. Without it, "Hide this
// occurrence" would dismiss the master's start date instead of the row
// the user clicked. The schedule-block link includes it for every
// row; deep-linked opens omit it and fall back to the master date.
export const Route = createFileRoute(
  "/_cadence/cadence/event/ical/$account/$externalId",
)({
  component: IcalEventView,
  validateSearch: (search: Record<string, unknown>): { date?: string } => {
    const raw = typeof search.date === "string" ? search.date : undefined;
    // Accept `YYYY-MM-DD` or an RFC3339 prefix; only the date portion
    // matters. Reject anything else so a malformed deep link doesn't
    // poison the dismiss key.
    if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      return { date: raw.slice(0, 10) };
    }
    return {};
  },
});

function IcalEventView() {
  const params = Route.useParams();
  const { date: occurrenceDate } = Route.useSearch();
  const accountId = decodeURIComponent(params.account);
  const externalId = decodeURIComponent(params.externalId);
  const { data: event } = useIcalEvent(accountId, externalId, occurrenceDate);

  return (
    <ContentPanel filePath={event?.path}>
      <IcalEventDetail
        accountId={accountId}
        externalId={externalId}
        occurrenceDate={occurrenceDate}
      />
    </ContentPanel>
  );
}
