import { describe, expect, it } from "vitest";
import {
  adjacentNavCursor,
  advanceTabHistory,
  tabPath,
  type OpenTab,
} from "./tabs-context-internal";

function tab(history: string[], cursor: number): OpenTab {
  return { id: "t1", history, cursor, title: "x" };
}

describe("advanceTabHistory", () => {
  it("pushes a new entry and advances the cursor", () => {
    const next = advanceTabHistory(tab(["/notebook"], 0), "/notebook/untitled", false);
    expect(next.history).toEqual(["/notebook", "/notebook/untitled"]);
    expect(next.cursor).toBe(1);
    expect(tabPath(next)).toBe("/notebook/untitled");
  });

  it("truncates the forward stack on a push from a back position", () => {
    // Cursor sits one back from the tip; a new push drops the forward entry.
    const next = advanceTabHistory(tab(["/a", "/b", "/c"], 1), "/d", false);
    expect(next.history).toEqual(["/a", "/b", "/d"]);
    expect(next.cursor).toBe(2);
  });

  it("overwrites the current entry in place on a replace", () => {
    const next = advanceTabHistory(tab(["/notebook", "/notebook/untitled"], 1), "/notebook/my-title", true);
    expect(next.history).toEqual(["/notebook", "/notebook/my-title"]);
    expect(next.cursor).toBe(1);
  });

  it("keeps Back honest after a note rename (the reported bug)", () => {
    // Create "Untitled" → push detail; then name it → replace to the new slug.
    let t = tab(["/notebook"], 0);
    t = advanceTabHistory(t, "/notebook/untitled", false);
    t = advanceTabHistory(t, "/notebook/my-essay", true); // rename = replace

    // The replaced-away URL must NOT linger in the back-stack.
    expect(t.history).toEqual(["/notebook", "/notebook/my-essay"]);
    // Stepping back lands on the index, not the dead /notebook/untitled.
    expect(t.history[t.cursor - 1]).toBe("/notebook");
    expect(t.history).not.toContain("/notebook/untitled");
  });
});

describe("adjacentNavCursor", () => {
  // [/a, /b, /c], currently showing /c.
  const t = tab(["/a", "/b", "/c"], 2);

  it("maps a native back onto the previous entry", () => {
    // Browser history moved back (delta < 0) to /b, the tab's prior entry.
    expect(adjacentNavCursor(t, "/b", -1)).toBe(1);
  });

  it("maps a native forward onto the next entry", () => {
    const mid = tab(["/a", "/b", "/c"], 1); // showing /b
    expect(adjacentNavCursor(mid, "/c", 1)).toBe(2);
  });

  it("returns null for a non-adjacent target (genuine push)", () => {
    // delta > 0 but /z isn't the forward neighbor → not a gesture, push it.
    expect(adjacentNavCursor(tab(["/a", "/b"], 0), "/z", 1)).toBeNull();
  });

  it("returns null when the move direction disagrees with the neighbor", () => {
    // /b is the forward neighbor, but delta is negative → not a back move.
    expect(adjacentNavCursor(tab(["/a", "/b"], 0), "/b", -1)).toBeNull();
  });

  it("returns null at the stack edges", () => {
    expect(adjacentNavCursor(tab(["/a"], 0), "/a", -1)).toBeNull();
    expect(adjacentNavCursor(tab(["/a", "/b"], 1), "/x", 1)).toBeNull();
  });

  it("returns null when the history index is unavailable (NaN delta)", () => {
    expect(adjacentNavCursor(t, "/b", NaN)).toBeNull();
  });
});
