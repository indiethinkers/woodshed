import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/",
  refreshCalendars: vi.fn(),
  refreshMail: vi.fn(),
  tauriInvoke: vi.fn(),
  toastError: vi.fn(),
  toastLoading: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, viewTransition: _viewTransition, ...props }: ComponentProps<"a"> & { to: string; viewTransition?: boolean }) => (
    <a href={to} {...props} />
  ),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: mocks.pathname } }),
}));

vi.mock("@/components/layout/right-sidebar-context-internal", () => ({
  useRightSidebar: () => ({ open: false, toggleSidebar: vi.fn() }),
}));

vi.mock("@/lib/hooks/use-gcal", () => ({
  useGcalSync: () => ({ mutateAsync: mocks.refreshCalendars }),
}));

vi.mock("@/lib/hooks/use-mail", () => ({
  useRefreshMail: () => mocks.refreshMail,
}));

vi.mock("@/lib/tauri", () => ({
  hasBackend: () => true,
  tauriInvoke: mocks.tauriInvoke,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
  },
}));

import { TitleBarActions, WoodshedRefreshButton } from "./title-bar-actions";

beforeEach(() => {
  mocks.pathname = "/";
  mocks.refreshCalendars.mockReset();
  mocks.refreshCalendars.mockResolvedValue({ accounts: [] });
  mocks.refreshMail.mockReset();
  mocks.refreshMail.mockResolvedValue({
    emails: [],
    stats: { durationMs: 0 },
  });
  mocks.tauriInvoke.mockReset();
  mocks.tauriInvoke.mockResolvedValue({
    summary: "Already up to date.",
    pulledPaths: 0,
    pulledFiles: [],
  });
  mocks.toastError.mockReset();
  mocks.toastLoading.mockReset();
  mocks.toastLoading.mockReturnValue("refresh-toast");
  mocks.toastSuccess.mockReset();
});

describe("TitleBarActions", () => {
  it("places Graph immediately before the appearance toggle", () => {
    render(<TitleBarActions />);

    const graph = screen.getByRole("link", { name: "Graph" });
    const appearance = screen.getByRole("button", {
      name: "Switch to dark mode",
    });
    expect(graph).toHaveAttribute("href", "/graph");
    expect(graph.nextElementSibling).toBe(appearance);
  });
});

describe("WoodshedRefreshButton", () => {
  it("finishes the vault refresh before refreshing calendar and mail accounts", async () => {
    let resolveVault!: (value: {
      summary: string;
      pulledPaths: number;
      pulledFiles: string[];
    }) => void;
    const vaultRefresh = new Promise<{
      summary: string;
      pulledPaths: number;
      pulledFiles: string[];
    }>((resolve) => {
      resolveVault = resolve;
    });
    mocks.tauriInvoke.mockReturnValue(vaultRefresh);
    render(<WoodshedRefreshButton />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Refresh vault, calendars, and mail",
      }),
    );

    expect(mocks.tauriInvoke).toHaveBeenCalledWith("vault_git_sync");
    expect(mocks.refreshCalendars).not.toHaveBeenCalled();
    expect(mocks.refreshMail).not.toHaveBeenCalled();

    await act(async () => {
      resolveVault({
        summary: "Already up to date.",
        pulledPaths: 0,
        pulledFiles: [],
      });
      await vaultRefresh;
    });

    await waitFor(() => {
      expect(mocks.refreshCalendars).toHaveBeenCalledWith();
      expect(mocks.refreshMail).toHaveBeenCalledWith();
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Woodshed refreshed", {
        id: "refresh-toast",
        description: "Already up to date.",
      });
    });
  });

  it("finishes every refresh and reports combined failures", async () => {
    mocks.tauriInvoke.mockRejectedValue(new Error("Git unavailable"));
    mocks.refreshCalendars.mockResolvedValue({
      accounts: [{ error: "Calendar unavailable" }],
    });
    mocks.refreshMail.mockRejectedValue(new Error("Mail unavailable"));
    render(<WoodshedRefreshButton />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Refresh vault, calendars, and mail",
      }),
    );

    await waitFor(() => {
      expect(mocks.refreshCalendars).toHaveBeenCalledWith();
      expect(mocks.refreshMail).toHaveBeenCalledWith();
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Woodshed refresh incomplete",
        {
          id: "refresh-toast",
          description:
            "Vault: Git unavailable Calendars: 1 account failed to refresh. Mail: Mail unavailable",
        },
      );
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("reports mail refreshes that only partially succeed", async () => {
    mocks.refreshMail.mockResolvedValue({
      emails: [],
      failedAccounts: 1,
      stats: { durationMs: 0 },
    });
    render(<WoodshedRefreshButton />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Refresh vault, calendars, and mail",
      }),
    );

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Woodshed refresh incomplete",
        {
          id: "refresh-toast",
          description: "Mail: 1 account failed to refresh.",
        },
      );
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
