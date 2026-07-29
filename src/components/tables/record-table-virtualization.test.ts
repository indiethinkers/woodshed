import { describe, expect, it } from "vitest";
import { calculateVisibleRowRange } from "./record-table";

describe("calculateVisibleRowRange", () => {
  it("returns an empty range at the end when a table is wholly above the viewport", () => {
    expect(
      calculateVisibleRowRange({
        rowCount: 10,
        top: -1_200,
        viewportHeight: 600,
      }),
    ).toEqual([10, 10]);
  });

  it("returns an empty range at the start when a table is wholly below the viewport", () => {
    expect(
      calculateVisibleRowRange({
        rowCount: 10,
        top: 1_200,
        viewportHeight: 600,
      }),
    ).toEqual([0, 0]);
  });
});
