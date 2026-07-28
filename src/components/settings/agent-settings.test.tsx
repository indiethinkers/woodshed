import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  baseUrl: "https://hermes.example.com/v1",
  credentialSource: "missing" as
    | "environment"
    | "hermes"
    | "stored"
    | "missing",
}));

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: vi.fn(async (command: string) => {
    if (command === "agent_config_get") {
      return {
        baseUrl: config.baseUrl,
        credentialSource: config.credentialSource,
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
  beforeEach(() => {
    config.baseUrl = "https://hermes.example.com/v1";
    config.credentialSource = "missing";
  });

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

  it("asks for no token when Hermes answers on this machine", async () => {
    config.baseUrl = "http://127.0.0.1:9000/v1";
    config.credentialSource = "hermes";

    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText("Local authentication")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Bearer token")).not.toBeInTheDocument();
    expect(document.getElementById("hermes-token-help")).toBeNull();
    expect(screen.getByText(/Nothing to paste into Woodshed/)).toBeVisible();
  });

  it("offers a custom key when no local Hermes key is found", async () => {
    config.baseUrl = "http://127.0.0.1:9000/v1";
    config.credentialSource = "missing";

    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText("Local authentication")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Enter a custom key" })).toBeEnabled();
  });
});
