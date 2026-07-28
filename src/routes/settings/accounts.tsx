import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/settings/settings-page";
import { GcalAccountSection } from "@/components/settings/gcal-accounts";
import { GmailAccountSection } from "@/components/settings/gmail-account";

export const Route = createFileRoute("/settings/accounts")({
  component: AccountsSettingsPage,
});

function AccountsSettingsPage() {
  return (
    <SettingsPage section="Integrations">
      <GmailAccountSection />
      <GcalAccountSection />
    </SettingsPage>
  );
}
