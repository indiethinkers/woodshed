import { describe, expect, it } from "vitest";
import {
  isTableRowDeleteShortcut,
  moveTableRowIds,
} from "./table-view";

const keyboardEvent = (key: string, overrides = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  defaultPrevented: false,
  ...overrides,
});

describe("table row interactions", () => {
  it("recognizes both Delete and macOS Backspace for selected rows", () => {
    expect(isTableRowDeleteShortcut(keyboardEvent("Delete"))).toBe(true);
    expect(isTableRowDeleteShortcut(keyboardEvent("Backspace"))).toBe(true);
    expect(isTableRowDeleteShortcut(keyboardEvent("Backspace", { metaKey: true }))).toBe(false);
    expect(isTableRowDeleteShortcut(keyboardEvent("Delete", { defaultPrevented: true }))).toBe(false);
  });

  it("moves a dragged row to the target row position", () => {
    expect(moveTableRowIds(["row_a", "row_b", "row_c"], "row_c", "row_a")).toEqual([
      "row_c",
      "row_a",
      "row_b",
    ]);
    expect(moveTableRowIds(["row_a"], "row_a", "row_a")).toBeNull();
    expect(moveTableRowIds(["row_a"], "missing", "row_a")).toBeNull();
  });
});
