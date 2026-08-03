import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  intervalMinutes: 5,
  refreshCalendar: vi.fn(async () => ({ accounts: [] })),
  refreshMail: vi.fn(async () => ({
    emails: [],
    stats: { durationMs: 10 },
    newMessages: 3,
  })),
  restoreSnoozes: vi.fn(async () => ({ restored: 0, failed: 0 })),
  info: vi.fn(),
}));

vi.mock("@/lib/hooks/use-gcal", () => ({
  useGcalSync: () => ({ mutateAsync: mocks.refreshCalendar }),
}));

vi.mock("@/lib/hooks/use-mail", () => ({
  useRefreshMail: () => mocks.refreshMail,
  useRestoreDueSnoozes: () => mocks.restoreSnoozes,
}));

vi.mock("@/lib/hooks/use-integration-refresh", () => ({
  useIntegrationRefreshSettings: () => ({
    data: { intervalMinutes: mocks.intervalMinutes },
  }),
}));

vi.mock("sonner", () => ({ toast: { info: mocks.info } }));

import { IntegrationRefreshScheduler } from "./integration-refresh-scheduler";

describe("IntegrationRefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
    mocks.intervalMinutes = 5;
    mocks.refreshCalendar.mockClear();
    mocks.refreshMail.mockClear();
    mocks.restoreSnoozes.mockClear();
    mocks.info.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes both integrations on the configured interval and batches new mail", async () => {
    render(<IntegrationRefreshScheduler />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });

    expect(mocks.refreshCalendar).toHaveBeenCalledOnce();
    expect(mocks.refreshMail).toHaveBeenCalledOnce();
    expect(mocks.info).toHaveBeenCalledWith("3 new emails");
  });

  it("does not schedule network refreshes in Manual mode", async () => {
    mocks.intervalMinutes = 0;
    render(<IntegrationRefreshScheduler />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });

    expect(mocks.refreshCalendar).not.toHaveBeenCalled();
    expect(mocks.refreshMail).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("checks due snoozes on launch and every minute even in Manual mode", async () => {
    mocks.intervalMinutes = 0;
    render(<IntegrationRefreshScheduler />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });

    expect(mocks.restoreSnoozes).toHaveBeenCalledTimes(2);
  });

  it("keeps its cadence across unrelated app rerenders", async () => {
    const { rerender } = render(<IntegrationRefreshScheduler />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    });
    rerender(<IntegrationRefreshScheduler />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });

    expect(mocks.refreshMail).toHaveBeenCalledOnce();
  });
});
