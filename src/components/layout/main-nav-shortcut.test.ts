import { describe, expect, it } from "vitest";
import { mainNavShortcutIndex } from "./main-nav-shortcut";

describe("mainNavShortcutIndex", () => {
  it("matches command number shortcuts", () => {
    expect(
      mainNavShortcutIndex(
        new KeyboardEvent("keydown", {
          code: "Digit1",
          key: "1",
          metaKey: true,
        }),
      ),
    ).toBe(0);

    expect(
      mainNavShortcutIndex(
        new KeyboardEvent("keydown", {
          code: "Digit7",
          key: "7",
          metaKey: true,
        }),
      ),
    ).toBe(6);

    expect(
      mainNavShortcutIndex(
        new KeyboardEvent("keydown", {
          code: "Digit8",
          key: "8",
          metaKey: true,
        }),
      ),
    ).toBe(7);
  });

  it("matches control number shortcuts", () => {
    expect(
      mainNavShortcutIndex(
        new KeyboardEvent("keydown", {
          code: "Digit3",
          key: "3",
          ctrlKey: true,
        }),
      ),
    ).toBe(2);
  });

  it("ignores numbers outside the main nav range", () => {
    expect(
      mainNavShortcutIndex(
        new KeyboardEvent("keydown", {
          code: "Digit9",
          key: "9",
          metaKey: true,
        }),
      ),
    ).toBe(null);
  });

  it("ignores shifted and alternate modified numbers", () => {
    expect(
      mainNavShortcutIndex(
        new KeyboardEvent("keydown", {
          code: "Digit1",
          key: "!",
          metaKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(null);

    expect(
      mainNavShortcutIndex(
        new KeyboardEvent("keydown", {
          code: "Digit1",
          key: "1",
          metaKey: true,
          altKey: true,
        }),
      ),
    ).toBe(null);
  });
});
