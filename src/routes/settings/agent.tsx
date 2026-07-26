import { createFileRoute } from "@tanstack/react-router";
import { AgentSettingsSection } from "@/components/settings/agent-settings";
import { SettingsPage } from "@/components/settings/settings-page";

export const Route = createFileRoute("/settings/agent")({
  component: AgentSettingsPage,
});

function AgentSettingsPage() {
  return (
    <SettingsPage section="Agent">
      <AgentSettingsSection />
    </SettingsPage>
  );
}
