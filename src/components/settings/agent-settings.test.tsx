import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: vi.fn(async (command: string) => {
    if (command === "agent_config_get") {
      return {
        baseUrl: "http://127.0.0.1:9000/v1",
        displayName: "Hermes",
        hasApiKey: false,
        model: "synthetic-model",
        sessionKey: "woodshed",
      };
    }
    return null;
  }),
}));

import { AgentSettingsSection } from "./agent-settings";

describe("AgentSettingsSection", () => {
  it("explains bearer-token setup without exposing protocol internals", async () => {
    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText("Bearer token")).toBeEnabled();
    });

    expect(
      screen.getByText(/Paste the token itself, without “Bearer” or “Authorization:”/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Woodshed adds the Authorization: Bearer header/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(screen.queryByText("Output Schema")).not.toBeInTheDocument();
  });
});
