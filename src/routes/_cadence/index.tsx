import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { DailyContent } from "@/components/cadence/daily-content";
import { useDailyJournal } from "@/lib/hooks/use-daily-journal";
import { useEvents } from "@/lib/hooks/use-events";
import { useGcalAccounts } from "@/lib/hooks/use-gcal";
import { useToday } from "@/lib/hooks/use-today";
import { isTauriRuntime } from "@/lib/runtime";

export const Route = createFileRoute("/_cadence/")({
  component: CadenceTodayPage,
});

// Renders today's cadence content at `/` directly — no URL change, no
// redirect. Under the old static-export Next setup we tried router.replace
// to `/cadence/<today>/` and looped on cold start, because only the
// `/cadence/_/` placeholder was prerendered. Vite removes that constraint
// — there is no placeholder route — but keeping `/` as its own renderer
// matches the user-facing model that "Today" lives at the root.
function CadenceTodayPage() {
  const today = useToday();
  // Parallel queries — same pattern as cadence/$date so the first
  // paint doesn't waterfall through three sequential Tauri calls.
  const { data: journal } = useDailyJournal(today);
  useEvents(today);
  useGcalAccounts();

  return (
    <ContentPanel
      filePath={journal?.path ?? `cadence/${today}.md`}
      wide
      showTopbar={false}
    >
      <DailyContent
        date={today}
        body={journal?.body ?? null}
        showInlineTasks={!isTauriRuntime()}
      />
    </ContentPanel>
  );
}
