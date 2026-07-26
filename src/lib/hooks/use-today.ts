"use client";

import { useEffect, useState } from "react";

// Returns today's date as YYYY-MM-DD in the user's local timezone.
// Recomputes when the document becomes visible (catches the case where
// the app was open overnight and crossed midnight).
//
// Replaces the hardcoded `TODAY_DATE = "2026-04-25"` constants in
// task-sidebar.tsx and (cadence)/page.tsx — see plan Phase 2 step 12.
export function useToday(): string {
  const [today, setToday] = useState<string>(() => formatLocalDate(new Date()));

  useEffect(() => {
    function refresh() {
      setToday(formatLocalDate(new Date()));
    }

    // Check on visibility change (covers app sleep, system sleep, tab switch).
    function onVisibility() {
      if (document.visibilityState === "visible") {
        refresh();
      }
    }

    document.addEventListener("visibilitychange", onVisibility);

    // Also wake at the next local midnight for long-running foreground sessions.
    const now = new Date();
    const nextMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      1,
    );
    const ms = nextMidnight.getTime() - now.getTime();
    const timer = window.setTimeout(refresh, ms);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearTimeout(timer);
    };
  }, []);

  return today;
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
