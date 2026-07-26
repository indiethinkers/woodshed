import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { DailyContent } from "@/components/cadence/daily-content";
import { useDailyJournal } from "@/lib/hooks/use-daily-journal";
import { useEvents } from "@/lib/hooks/use-events";
import { useGcalAccounts } from "@/lib/hooks/use-gcal";
import { isTauriRuntime } from "@/lib/runtime";

export const Route = createFileRoute("/_cadence/cadence/$date/")({
  component: DailyDateView,
});

function DailyDateView() {
  const { date } = Route.useParams();
  // Fire all three queries at the page level so they run in parallel.
  // Without this, useEvents/useGcalAccounts wouldn't kick off until
  // ScheduleBlock mounted — i.e. after useDailyJournal resolved — turning
  // independent reads into a waterfall. TanStack Query dedupes the calls
  // from child components, so this is purely a kickoff hint.
  const { data: journal } = useDailyJournal(date);
  useEvents(date);
  useGcalAccounts();

  return (
    <ContentPanel
      filePath={journal?.path ?? `cadence/${date}.md`}
      wide
      showTopbar={false}
    >
      <DailyContent
        date={date}
        body={journal?.body ?? null}
        showInlineTasks={!isTauriRuntime()}
      />
    </ContentPanel>
  );
}
