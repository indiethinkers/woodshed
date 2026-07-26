import { describe, expect, it } from "vitest";
import { canShowAgentPanel, isAgentFocusMode } from "./agent-panel-route";

describe("canShowAgentPanel", () => {
  it("allows the page chat on normal surfaces and settings", () => {
    expect(canShowAgentPanel("/")).toBe(true);
    expect(canShowAgentPanel("/notebook/field-notes")).toBe(true);
    expect(canShowAgentPanel("/settings/agent")).toBe(true);
  });

  it("excludes the full Agent and welcome surfaces", () => {
    expect(canShowAgentPanel("/agent")).toBe(false);
    expect(canShowAgentPanel("/agent?chat=chat-1")).toBe(false);
    expect(canShowAgentPanel("/welcome")).toBe(false);
  });
});

describe("isAgentFocusMode", () => {
  it("focuses normal surfaces while the contextual Bot panel is open", () => {
    expect(isAgentFocusMode("/notebook/field-notes", true)).toBe(true);
    expect(isAgentFocusMode("/settings/agent", true)).toBe(true);
  });

  it("keeps the rail for closed panels and the dedicated Agent page", () => {
    expect(isAgentFocusMode("/notebook/field-notes", false)).toBe(false);
    expect(isAgentFocusMode("/agent", true)).toBe(false);
    expect(isAgentFocusMode("/welcome", true)).toBe(false);
  });
});
