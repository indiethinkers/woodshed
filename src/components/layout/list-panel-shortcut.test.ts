import { describe, expect, it } from "vitest";
import { isListPanelToggleShortcut } from "./list-panel-shortcut";

describe("isListPanelToggleShortcut", () => {
  it("matches command backslash", () => {
    expect(
      isListPanelToggleShortcut(
        new KeyboardEvent("keydown", {
          code: "Backslash",
          key: "\\",
          metaKey: true,
        }),
      ),
    ).toBe(true);
  });

  it("matches control backslash", () => {
    expect(
      isListPanelToggleShortcut(
        new KeyboardEvent("keydown", {
          code: "Backslash",
          key: "\\",
          ctrlKey: true,
        }),
      ),
    ).toBe(true);
  });

  it("ignores shifted and alternate modified backslash", () => {
    expect(
      isListPanelToggleShortcut(
        new KeyboardEvent("keydown", {
          code: "Backslash",
          key: "|",
          metaKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(false);

    expect(
      isListPanelToggleShortcut(
        new KeyboardEvent("keydown", {
          code: "Backslash",
          key: "\\",
          metaKey: true,
          altKey: true,
        }),
      ),
    ).toBe(false);
  });
});
