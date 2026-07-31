import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: invoke,
}));

import { DemoClockProvider, useDisplayNow, useFixedNowMs } from "./demo-clock";
import { useToday } from "./hooks/use-today";

function wrapper({ children }: { children: ReactNode }) {
  return <DemoClockProvider>{children}</DemoClockProvider>;
}

beforeEach(() => {
  invoke.mockReset();
});

describe("DemoClockProvider", () => {
  it("freezes display time when app data has a clock for the selected vault", async () => {
    invoke.mockResolvedValue({ now: "2026-10-12T13:15:00-07:00" });

    const { result } = renderHook(
      () => ({ fixed: useFixedNowMs(), now: useDisplayNow(10) }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.fixed).toBe(
        Date.parse("2026-10-12T13:15:00-07:00"),
      );
    });
    expect(result.current.now.toISOString()).toBe("2026-10-12T20:15:00.000Z");
    expect(invoke).toHaveBeenCalledWith("demo_clock_get");
  });

  it("makes the frozen date the app's today", async () => {
    invoke.mockResolvedValue({ now: "2026-10-12T13:15:00-07:00" });

    const { result } = renderHook(() => useToday(), { wrapper });

    await waitFor(() => expect(result.current).toBe("2026-10-12"));
  });

  it("leaves ordinary vaults on the system clock", async () => {
    invoke.mockResolvedValue(null);

    const { result } = renderHook(() => useFixedNowMs(), { wrapper });

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
