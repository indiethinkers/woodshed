import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { tauriInvoke } from "@/lib/tauri";

interface VaultDemoClock {
  now: string;
}

const FixedNowContext = createContext<number | null>(null);

/** Loads the optional app-data clock scoped to the selected demo vault. */
export function DemoClockProvider({ children }: { children: ReactNode }) {
  const [fixedNowMs, setFixedNowMs] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void tauriInvoke<VaultDemoClock | null>("demo_clock_get")
      .then((clock) => {
        if (cancelled || !clock) return;
        const parsed = Date.parse(clock.now);
        if (!Number.isNaN(parsed)) setFixedNowMs(parsed);
      })
      .catch(() => {
        // A malformed marker is already reported through the normal invoke
        // logging path. Falling back to the system clock keeps the app usable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <FixedNowContext.Provider value={fixedNowMs}>
      {children}
    </FixedNowContext.Provider>
  );
}

export function useFixedNowMs(): number | null {
  return useContext(FixedNowContext);
}

/** Current display time, frozen when the selected vault supplies a demo clock. */
export function useDisplayNow(tickMs: number | null = null): Date {
  const fixedNowMs = useFixedNowMs();
  const [liveNow, setLiveNow] = useState(() => new Date());

  useEffect(() => {
    if (fixedNowMs !== null) return;
    setLiveNow(new Date());
    if (tickMs === null) return;
    const id = window.setInterval(() => setLiveNow(new Date()), tickMs);
    return () => window.clearInterval(id);
  }, [fixedNowMs, tickMs]);

  return useMemo(
    () => (fixedNowMs === null ? liveNow : new Date(fixedNowMs)),
    [fixedNowMs, liveNow],
  );
}
