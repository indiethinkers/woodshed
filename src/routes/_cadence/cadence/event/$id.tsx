import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ContentPanel } from "@/components/layout/content-panel";
import { EventDetail } from "@/components/cadence/event-detail";
import { useEvent } from "@/lib/hooks/use-events";

export const Route = createFileRoute("/_cadence/cadence/event/$id")({
  component: EventView,
});

function EventView() {
  const { id } = Route.useParams();
  const { data: event } = useEvent(id);
  const navigate = useNavigate();

  useEffect(() => {
    if (
      event?.provider !== "ical" ||
      !event.accountId ||
      !event.externalId
    ) {
      return;
    }
    const occurrenceDate = event.date.slice(0, 10);
    void navigate({
      href: `/cadence/event/ical/${encodeURIComponent(event.accountId)}/${encodeURIComponent(event.externalId)}?date=${occurrenceDate}`,
      replace: true,
    });
  }, [event, navigate]);

  // Only the path is needed for ContentPanel — EventDetail re-fetches via
  // useEvent on its own and renders skeletons / not-found states.
  return (
    <ContentPanel filePath={event?.path}>
      <EventDetail id={id} />
    </ContentPanel>
  );
}
