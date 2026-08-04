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
  managedProfile: null as {
    name: string;
    port: number;
    model: string;
    available: boolean;
  } | null,
}));
const connection = vi.hoisted(() => ({
  error: null as Error | null,
  pending: null as Promise<unknown> | null,
  result: {
    ok: true,
    status: 200,
    modelFound: true,
    models: ["focus"],
    message: "Connected to Hermes and found the active profile model.",
    managedProfile: null as {
      name: string;
      port: number;
      model: string;
      available: boolean;
    } | null,
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
    config.managedProfile = null;
    connection.error = null;
    connection.pending = null;
    connection.result = {
      ok: true,
      status: 200,
      modelFound: true,
      models: ["focus"],
      message: "Connected to Hermes and found the active profile model.",
      managedProfile: null,
    };
    tauriInvokeMock.mockReset();
    tauriInvokeMock.mockImplementation(async (command: string) => {
      if (command === "agent_config_get" || command === "agent_config_set") {
        return {
          baseUrl: config.baseUrl,
          credentialSource: config.credentialSource,
          displayName: "Hermes",
          hasApiKey: config.credentialSource !== "missing",
          managedProfile: config.managedProfile,
          model: config.model,
          sessionKey: "woodshed",
        };
      }
      if (command === "agent_connection_test") {
        if (connection.error) throw connection.error;
        if (connection.pending) return connection.pending;
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
    config.managedProfile = {
      name: "focus",
      port: 8651,
      model: "focus-gateway",
      available: true,
    };

    render(<AgentSettingsSection />);

    expect(await screen.findByText("Focus profile")).toBeVisible();
    expect(screen.queryByLabelText("Bearer token")).not.toBeInTheDocument();
    expect(document.getElementById("hermes-token-help")).toBeNull();
    expect(screen.queryByText("Local authentication")).not.toBeInTheDocument();
  });

  it("hides managed connection fields until custom endpoint mode is enabled", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "hermes";
    config.model = "hermes-agent";
    config.managedProfile = {
      name: "focus",
      port: 8651,
      model: "focus-gateway",
      available: true,
    };

    render(<AgentSettingsSection />);

    expect(await screen.findByText("Focus profile")).toBeVisible();
    expect(screen.getByText("Not checked")).toBeVisible();
    expect(screen.getByText(/focus on port 8651/i)).toBeVisible();
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Session key")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).toBeEnabled();

    fireEvent.click(
      screen.getByRole("button", { name: "Use a custom endpoint" }),
    );

    expect(screen.getByLabelText("Base URL")).toHaveValue(
      "http://127.0.0.1:8651/v1",
    );
    expect(screen.getByLabelText("Model")).toHaveValue("focus-gateway");
    expect(screen.getByLabelText("Base URL")).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("Model")).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("Session key")).not.toHaveAttribute(
      "readonly",
    );
    expect(screen.getByText("Local authentication")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(tauriInvokeMock).toHaveBeenCalledWith(
        "agent_config_set",
        expect.objectContaining({
          input: expect.objectContaining({
            baseUrl: "http://127.0.0.1:8651/v1",
            model: "focus-gateway",
          }),
        }),
      );
    });
  });

  it("shows setup guidance when the active profile credential is missing", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "missing";
    config.model = "hermes-agent";
    config.managedProfile = {
      name: "focus",
      port: 8651,
      model: "focus-gateway",
      available: true,
    };

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
    config.managedProfile = {
      name: "focus",
      port: 8651,
      model: "focus-gateway",
      available: true,
    };
    connection.result.managedProfile = {
      name: "review",
      port: 8653,
      model: "review-gateway",
      available: true,
    };

    render(<AgentSettingsSection />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Test connection" }),
    );

    expect(await screen.findByText("Connected")).toBeVisible();
    expect(
      screen.getByText(/Review is running locally on port 8653/i),
    ).toBeVisible();
    expect(tauriInvokeMock).toHaveBeenCalledWith("agent_connection_test");
    expect(tauriInvokeMock).not.toHaveBeenCalledWith(
      "agent_config_set",
      expect.anything(),
    );
  });

  it("reserves stable card geometry while a connection test is running", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "hermes";
    config.model = "hermes-agent";
    config.managedProfile = {
      name: "focus",
      port: 8651,
      model: "focus-gateway",
      available: true,
    };
    let finishTest: ((value: typeof connection.result) => void) | undefined;
    connection.pending = new Promise((resolve) => {
      finishTest = resolve;
    });

    render(<AgentSettingsSection />);

    const testButton = await screen.findByRole("button", {
      name: "Test connection",
    });
    const card = screen.getByTestId("managed-hermes-connection");
    const message = screen.getByTestId("managed-hermes-status-message");
    expect(card).toHaveClass("sm:min-h-[80px]");
    expect(message).toHaveClass("min-h-8");
    expect(testButton).toHaveClass("min-w-[128px]");

    fireEvent.click(testButton);
    expect(await screen.findByRole("button", { name: "Testing…" })).toBe(
      testButton,
    );
    expect(screen.getByTestId("managed-hermes-connection")).toBe(card);

    finishTest?.(connection.result);
    expect(await screen.findByText("Connected")).toBeVisible();
    expect(screen.getByTestId("managed-hermes-connection")).toBe(card);
  });

  it("reports when the local Hermes gateway is unavailable", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "hermes";
    config.model = "hermes-agent";
    config.managedProfile = {
      name: "focus",
      port: 8651,
      model: "focus-gateway",
      available: true,
    };
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

  it("shows an unreadable active profile as unavailable", async () => {
    config.baseUrl = "http://127.0.0.1:8642/v1";
    config.credentialSource = "missing";
    config.model = "hermes-agent";
    config.managedProfile = {
      name: "review",
      port: 8642,
      model: "review",
      available: false,
    };

    render(<AgentSettingsSection />);

    expect(await screen.findByText("Unavailable")).toBeVisible();
    expect(screen.getByText(/could not safely read/i)).toBeVisible();
    expect(screen.queryByText("Setup needed")).not.toBeInTheDocument();
  });
});
