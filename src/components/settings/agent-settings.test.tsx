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
const connection = vi.hoisted(() => ({
  error: null as Error | null,
  result: {
    ok: true,
    status: 200,
    modelFound: true,
    models: ["hermes-agent"],
    message: "Connected to Hermes and found the gateway model.",
  },
}));
const tauriInvokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: tauriInvokeMock,
}));

import { AgentSettingsSection } from "./agent-settings";

describe("AgentSettingsSection", () => {
  beforeEach(() => {
    config.baseUrl = "https://hermes.example.com/v1";
    config.credentialSource = "missing";
    config.model = "synthetic-model";
    connection.error = null;
    connection.result = {
      ok: true,
      status: 200,
      modelFound: true,
      models: ["hermes-agent"],
      message: "Connected to Hermes and found the gateway model.",
    };
    tauriInvokeMock.mockReset();
    tauriInvokeMock.mockImplementation(async (command: string) => {
      if (command === "agent_config_get" || command === "agent_config_set") {
        return {
          baseUrl: config.baseUrl,
          credentialSource: config.credentialSource,
          displayName: "Hermes",
          hasApiKey: config.credentialSource !== "missing",
          model: config.model,
          sessionKey: "woodshed",
        };
      }
      if (command === "agent_connection_test") {
        if (connection.error) throw connection.error;
        return connection.result;
      }
      return null;
    });
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

  it("does not expose connection credentials for the managed profile", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "hermes";
    config.model = "hermes-agent";

    render(<AgentSettingsSection />);

    expect(await screen.findByText("Hermes default profile")).toBeVisible();
    expect(screen.queryByLabelText("Bearer token")).not.toBeInTheDocument();
    expect(document.getElementById("hermes-token-help")).toBeNull();
    expect(screen.queryByText("Local authentication")).not.toBeInTheDocument();
  });

  it("hides managed connection fields until custom endpoint mode is enabled", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "hermes";
    config.model = "hermes-agent";

    render(<AgentSettingsSection />);

    expect(await screen.findByText("Hermes default profile")).toBeVisible();
    expect(screen.getByText("Not checked")).toBeVisible();
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Session key")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).toBeEnabled();

    fireEvent.click(
      screen.getByRole("button", { name: "Use a custom endpoint" }),
    );

    expect(screen.getByLabelText("Base URL")).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("Model")).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("Session key")).not.toHaveAttribute(
      "readonly",
    );
    expect(screen.getByText("Local authentication")).toBeVisible();
  });

  it("shows setup guidance when the default profile credential is missing", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "missing";
    config.model = "hermes-agent";

    render(<AgentSettingsSection />);

    expect(await screen.findByText("Setup needed")).toBeVisible();
    expect(
      screen.getByText(/could not find API_SERVER_KEY/i),
    ).toBeVisible();
  });

  it("reports that the local Hermes profile is connected after testing", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "hermes";
    config.model = "hermes-agent";

    render(<AgentSettingsSection />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Test connection" }),
    );

    expect(await screen.findByText("Connected")).toBeVisible();
    expect(
      screen.getByText(/Hermes is running locally and responding/i),
    ).toBeVisible();
    expect(tauriInvokeMock).toHaveBeenCalledWith("agent_connection_test");
    expect(tauriInvokeMock).not.toHaveBeenCalledWith(
      "agent_config_set",
      expect.anything(),
    );
  });

  it("reports when the local Hermes gateway is unavailable", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "hermes";
    config.model = "hermes-agent";
    connection.error = new Error(
      "Connect failed. Is the local Hermes gateway running?",
    );

    render(<AgentSettingsSection />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Test connection" }),
    );

    expect(await screen.findByText("Unavailable")).toBeVisible();
    expect(
      screen.getByText(/Is the local Hermes gateway running/i),
    ).toBeVisible();
  });
});
