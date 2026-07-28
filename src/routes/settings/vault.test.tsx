import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The page renders inside SettingsPage, which needs Link + useRouterState for
// its section nav. Stub both so the tree mounts without a RouterProvider.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useRouterState: () => "/settings/vault",
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/hooks/use-search", () => ({
  useReindex: () => ({ mutateAsync: vi.fn(async () => 0), isPending: false }),
}));

const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
  if (cmd === "vault_path_get") return "/Users/me/woodshed";
  if (cmd === "logs_path") return "/Users/me/Library/Logs/woodshed.log";
  return null;
});

vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  tauriInvoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

const openDialog = vi.fn(async () => "/Users/me/woodshed-demo");
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => openDialog() }));

import { VaultSettingsPage } from "./vault";

const CONFIRM = "Switch and relaunch";

async function pickAFolder() {
  render(<VaultSettingsPage />);
  fireEvent.click(screen.getByRole("button", { name: /Change/ }));
  await screen.findByText("Switch to this vault?");
}

describe("VaultSettingsPage — changing the vault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openDialog.mockResolvedValue("/Users/me/woodshed-demo");
  });

  it("shows the configured vault path", async () => {
    render(<VaultSettingsPage />);
    expect(await screen.findByText("/Users/me/woodshed")).toBeInTheDocument();
  });

  it("does not switch straight off the folder picker", async () => {
    await pickAFolder();
    // Picking a folder only stages it — switching restarts the app, so it
    // must never happen without a second, explicit confirmation.
    expect(invoke).not.toHaveBeenCalledWith("vault_switch", expect.anything());
    expect(screen.getByRole("button", { name: CONFIRM })).toBeInTheDocument();
  });

  it("sends the picked path when confirmed", async () => {
    await pickAFolder();
    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("vault_switch", {
        path: "/Users/me/woodshed-demo",
      }),
    );
  });

  it("abandons the switch on cancel", async () => {
    await pickAFolder();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Switch to this vault?")).not.toBeInTheDocument(),
    );
    expect(invoke).not.toHaveBeenCalledWith("vault_switch", expect.anything());
  });

  it("surfaces a rejected switch instead of failing silently", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_path_get") return "/Users/me/woodshed";
      if (cmd === "vault_switch") throw new Error("That is already your vault.");
      return null;
    });
    await pickAFolder();
    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already your vault/);
    // Still recoverable — the confirm button must not be stuck disabled.
    expect(screen.getByRole("button", { name: CONFIRM })).toBeEnabled();
  });

  it("warns when the chosen folder is inside iCloud Drive", async () => {
    openDialog.mockResolvedValue(
      "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/vault",
    );
    await pickAFolder();
    expect(screen.getByText(/inside iCloud Drive/)).toBeInTheDocument();
  });
});
