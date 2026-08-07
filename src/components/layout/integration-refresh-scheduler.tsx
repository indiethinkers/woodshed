import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { describeIntegrationRefreshFailures } from "@/lib/integration-refresh-failures";
import { useGcalSync } from "@/lib/hooks/use-gcal";
import { useIntegrationRefreshSettings } from "@/lib/hooks/use-integration-refresh";
import {
  useRefreshMail,
  useRestoreDueSnoozes,
} from "@/lib/hooks/use-mail";

const REFRESH_ERROR_TOAST_COOLDOWN_MS = 5 * 60 * 1000;
let lastScheduledRefreshErrorToastAt = 0;

export function IntegrationRefreshScheduler() {
  const { data: settings } = useIntegrationRefreshSettings();
  const calendarSync = useGcalSync();
  const refreshMail = useRefreshMail();
  const restoreDueSnoozes = useRestoreDueSnoozes();
  const running = useRef(false);
  const restoringSnoozes = useRef(false);
  const refreshCalendarRef = useRef(calendarSync.mutateAsync);
  const refreshMailRef = useRef(refreshMail);
  const restoreDueSnoozesRef = useRef(restoreDueSnoozes);
  refreshCalendarRef.current = calendarSync.mutateAsync;
  refreshMailRef.current = refreshMail;
  restoreDueSnoozesRef.current = restoreDueSnoozes;

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      if (cancelled || restoringSnoozes.current) return;
      restoringSnoozes.current = true;
      try {
        const result = await restoreDueSnoozesRef.current();
        if (result.restored === 1) toast.info("1 snoozed email returned");
        else if (result.restored > 1) {
          toast.info(`${result.restored} snoozed emails returned`);
        }
      } finally {
        restoringSnoozes.current = false;
      }
    };
    void restore();
    const timer = window.setInterval(() => void restore(), 60 * 1000);
    window.addEventListener("focus", restore);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", restore);
    };
  }, []);

  useEffect(() => {
    const intervalMinutes = settings?.intervalMinutes ?? 5;
    if (intervalMinutes <= 0) return;

    const intervalMs = intervalMinutes * 60 * 1000;
    let lastStartedAt = Date.now();
    let cancelled = false;

    const refresh = async () => {
      if (cancelled || running.current) return;
      running.current = true;
      lastStartedAt = Date.now();
      try {
        const [calendarResult, mailResult] = await Promise.allSettled([
          refreshCalendarRef.current(),
          refreshMailRef.current(),
        ]);
        const failures = describeIntegrationRefreshFailures(
          calendarResult,
          mailResult,
        );
        if (failures.length > 0) {
          const now = Date.now();
          if (now - lastScheduledRefreshErrorToastAt >= REFRESH_ERROR_TOAST_COOLDOWN_MS) {
            lastScheduledRefreshErrorToastAt = now;
            toast.error("Background refresh incomplete", {
              description: failures.join(" "),
            });
          }
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
