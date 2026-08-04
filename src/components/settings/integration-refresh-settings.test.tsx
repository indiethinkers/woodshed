import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setSettings: vi.fn(async () => ({ intervalMinutes: 15 })),
}));

vi.mock("@/lib/hooks/use-integration-refresh", () => ({
  INTEGRATION_REFRESH_INTERVALS: [0, 5, 15, 30, 60],
  useIntegrationRefreshSettings: () => ({
    data: { intervalMinutes: 0 },
    isLoading: false,
  }),
  useSetIntegrationRefreshSettings: () => ({
    mutateAsync: mocks.setSettings,
    isPending: false,
  }),
}));

import { IntegrationRefreshSettingsSection } from "./integration-refresh-settings";

describe("IntegrationRefreshSettingsSection", () => {
  it("lets the user opt into a bounded polling interval", async () => {
    render(<IntegrationRefreshSettingsSection />);

    const select = screen.getByRole("combobox", {
      name: "Automatic refresh interval",
    });
    expect(select).toHaveValue("0");

    fireEvent.change(select, { target: { value: "15" } });

    await waitFor(() =>
      expect(mocks.setSettings).toHaveBeenCalledWith({ intervalMinutes: 15 }),
    );
  });
});
