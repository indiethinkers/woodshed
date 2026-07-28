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
  it("explains where the Hermes token comes from in one paragraph", async () => {
    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText("Bearer token")).toBeEnabled();
    });

    const help = document.getElementById("hermes-token-help")!;
    expect(help.tagName).toBe("P");
    expect(help).toHaveTextContent(/API_SERVER_KEY/);
    expect(help).toHaveTextContent(/Woodshed does not issue it/);
    expect(help).toHaveTextContent(
      /Paste only the value—without “Bearer” or “Authorization:”/,
    );
    expect(help.querySelector("p")).toBeNull();
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(screen.queryByText("Output Schema")).not.toBeInTheDocument();
  });
});
