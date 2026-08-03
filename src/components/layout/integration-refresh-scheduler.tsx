import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useGcalSync } from "@/lib/hooks/use-gcal";
import { useIntegrationRefreshSettings } from "@/lib/hooks/use-integration-refresh";
import { useRefreshMail } from "@/lib/hooks/use-mail";

export function IntegrationRefreshScheduler() {
  const { data: settings } = useIntegrationRefreshSettings();
  const calendarSync = useGcalSync();
  const refreshMail = useRefreshMail();
  const running = useRef(false);
  const refreshCalendarRef = useRef(calendarSync.mutateAsync);
  const refreshMailRef = useRef(refreshMail);
  refreshCalendarRef.current = calendarSync.mutateAsync;
  refreshMailRef.current = refreshMail;

  useEffect(() => {
    const intervalMinutes = settings?.intervalMinutes ?? 0;
    if (intervalMinutes <= 0) return;

    const intervalMs = intervalMinutes * 60 * 1000;
    let lastStartedAt = Date.now();
    let cancelled = false;

    const refresh = async () => {
      if (cancelled || running.current) return;
      running.current = true;
      lastStartedAt = Date.now();
      try {
        const [, mail] = await Promise.allSettled([
          refreshCalendarRef.current(),
          refreshMailRef.current(),
        ]);
        if (mail.status === "fulfilled") {
          const count = mail.value.newMessages ?? 0;
          if (count === 1) toast.info("1 new email");
          else if (count > 1) toast.info(`${count} new emails`);
        }
      } finally {
        running.current = false;
      }
    };

    const timer = window.setInterval(() => void refresh(), intervalMs);
    const catchUpIfDue = () => {
      if (Date.now() - lastStartedAt >= intervalMs) void refresh();
    };
    const catchUpWhenVisible = () => {
      if (document.visibilityState === "visible") catchUpIfDue();
    };
    window.addEventListener("focus", catchUpIfDue);
    document.addEventListener("visibilitychange", catchUpWhenVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", catchUpIfDue);
      document.removeEventListener("visibilitychange", catchUpWhenVisible);
    };
  }, [settings?.intervalMinutes]);

  return null;
}
