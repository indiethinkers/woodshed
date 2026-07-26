import { describe, expect, it } from "vitest";
import { isAgentPanelToggleShortcut } from "./agent-panel-shortcut";

describe("isAgentPanelToggleShortcut", () => {
  it("matches command or control B", () => {
    expect(
      isAgentPanelToggleShortcut(
        new KeyboardEvent("keydown", { code: "KeyB", metaKey: true }),
      ),
    ).toBe(true);
    expect(
      isAgentPanelToggleShortcut(
        new KeyboardEvent("keydown", { code: "KeyB", ctrlKey: true }),
      ),
    ).toBe(true);
  });

  it("rejects modified and unmodified B presses", () => {
    expect(
      isAgentPanelToggleShortcut(
        new KeyboardEvent("keydown", {
          code: "KeyB",
          metaKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(false);
    expect(
      isAgentPanelToggleShortcut(
        new KeyboardEvent("keydown", { code: "KeyB" }),
      ),
    ).toBe(false);
  });
});
