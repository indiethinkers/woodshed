import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  baseUrl: "https://hermes.example.com/v1",
  credentialSource: "missing" as
    | "environment"
    | "hermes"
    | "stored"
    | "missing",
  model: "synthetic-model",
}));

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: vi.fn(async (command: string) => {
    if (command === "agent_config_get") {
      return {
        baseUrl: config.baseUrl,
        credentialSource: config.credentialSource,
        displayName: "Hermes",
        hasApiKey: false,
        model: config.model,
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
    config.model = "synthetic-model";
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
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "hermes";
    config.model = "hermes-agent";

    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText("Local authentication")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Bearer token")).not.toBeInTheDocument();
    expect(document.getElementById("hermes-token-help")).toBeNull();
    expect(screen.getByText(/Nothing to paste into Woodshed/)).toBeVisible();
  });

  it("keeps the default Hermes profile settings read only", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "hermes";
    config.model = "hermes-agent";

    render(<AgentSettingsSection />);

    expect(await screen.findByText("Default profile")).toBeVisible();
    expect(screen.getByLabelText("Base URL")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Gateway model")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Session key")).toHaveAttribute("readonly");
    expect(
      screen.getAllByText(/Change its model and provider in Hermes/),
    ).not.toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Use a custom endpoint" }),
    );

    expect(screen.getByLabelText("Base URL")).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("Model")).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("Session key")).not.toHaveAttribute(
      "readonly",
    );
  });

  it("offers a custom key when no local Hermes key is found", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "missing";
    config.model = "hermes-agent";

    render(<AgentSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText("Local authentication")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: "Enter a custom key" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Configure the default profile in Hermes/),
    ).toBeVisible();
  });
});
