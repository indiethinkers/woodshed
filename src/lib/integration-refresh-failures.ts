import type { SyncReport } from "@/lib/hooks/use-gcal";
import type { MailSyncResult } from "@/lib/mail-lib/types";

export function integrationRefreshErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 220 ? `${message.slice(0, 217)}...` : message;
}

export function describeIntegrationRefreshFailures(
  calendarResult: PromiseSettledResult<SyncReport>,
  mailResult: PromiseSettledResult<MailSyncResult>,
): string[] {
  const failures: string[] = [];

  if (calendarResult.status === "rejected") {
    failures.push(`Calendars: ${integrationRefreshErrorMessage(calendarResult.reason)}`);
  } else {
    const failedAccounts = calendarResult.value.accounts.filter(
      (account) => account.error,
    ).length;
    if (failedAccounts > 0) {
      failures.push(
        `Calendars: ${failedAccounts} account${failedAccounts === 1 ? "" : "s"} failed to refresh.`,
      );
    }
  }

  if (mailResult.status === "rejected") {
    failures.push(`Mail: ${integrationRefreshErrorMessage(mailResult.reason)}`);
  } else if (mailResult.value.failedAccounts) {
    const failedAccounts = mailResult.value.failedAccounts;
    failures.push(
      `Mail: ${failedAccounts} account${failedAccounts === 1 ? "" : "s"} failed to refresh.`,
    );
  }

  return failures;
}
