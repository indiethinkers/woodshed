import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tauriInvoke: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: mocks.tauriInvoke,
}));

import { mailSyncRecentMulti } from "./mail";

beforeEach(() => {
  mocks.tauriInvoke.mockReset();
});

describe("mailSyncRecentMulti", () => {
  it("reports a failed account when another account refreshes successfully", async () => {
    mocks.tauriInvoke.mockImplementation(
      (command: string, args?: { accountEmail?: string }) => {
        if (command === "gmail_accounts_list") {
          return Promise.resolve([
            {
              email: "alpha@example.invalid",
              inbox: "gmail:alpha@example.invalid",
              displayName: "Alpha",
            },
            {
              email: "beta@example.invalid",
              inbox: "gmail:beta@example.invalid",
              displayName: "Beta",
            },
          ]);
        }
        if (
          command === "gmail_sync_recent" &&
          args?.accountEmail === "alpha@example.invalid"
        ) {
          return Promise.resolve({
            written: ["message-1"],
            fetched: 1,
            removed: 0,
            durationMs: 25,
            email: "alpha@example.invalid",
          });
        }
        if (command === "gmail_sync_recent") {
          return Promise.reject(new Error("Account unavailable"));
        }
        return Promise.resolve(null);
      },
    );

    const result = await mailSyncRecentMulti();

    expect(result.emails).toHaveLength(1);
    expect(result.failedAccounts).toBe(1);
  });
});
