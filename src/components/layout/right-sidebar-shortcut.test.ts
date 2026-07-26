import { describe, expect, it } from "vitest";
import { isRightSidebarToggleShortcut } from "./right-sidebar-shortcut";

describe("isRightSidebarToggleShortcut", () => {
  it("matches command or control slash", () => {
    expect(
      isRightSidebarToggleShortcut(
        new KeyboardEvent("keydown", {
          code: "Slash",
          key: "/",
          metaKey: true,
        }),
      ),
    ).toBe(true);

    expect(
      isRightSidebarToggleShortcut(
        new KeyboardEvent("keydown", {
          code: "Slash",
          key: "/",
          ctrlKey: true,
        }),
      ),
    ).toBe(true);
  });

  it("rejects shifted, alternate, and unmodified slash presses", () => {
    expect(
      isRightSidebarToggleShortcut(
        new KeyboardEvent("keydown", {
          code: "Slash",
          key: "?",
          metaKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(false);

    expect(
      isRightSidebarToggleShortcut(
        new KeyboardEvent("keydown", {
          code: "Slash",
          key: "/",
          metaKey: true,
          altKey: true,
        }),
      ),
    ).toBe(false);

    expect(
      isRightSidebarToggleShortcut(
        new KeyboardEvent("keydown", { code: "Slash", key: "/" }),
      ),
    ).toBe(false);
  });
});
