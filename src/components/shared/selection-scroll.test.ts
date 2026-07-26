import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@tiptap/pm/view";
import {
  handleScrollToVisibleSelection,
  selectionRectIsVisible,
} from "./selection-scroll";

function rect(top: number, bottom: number, left = 0, right = 100) {
  return { top, bottom, left, right } as DOMRect;
}

function viewWithRects(selectionRect: DOMRect, viewportRect: DOMRect) {
  const viewport = {
    getBoundingClientRect: vi.fn(() => viewportRect),
  };
  const dom = {
    closest: vi.fn(() => viewport),
  };
  return {
    dom,
    state: { selection: { head: 7 } },
    coordsAtPos: vi.fn(() => selectionRect),
  } as unknown as EditorView;
}

function viewWithoutViewport(selectionRect: DOMRect) {
  const dom = {
    closest: vi.fn(() => null),
  };
  return {
    dom,
    state: { selection: { head: 7 } },
    coordsAtPos: vi.fn(() => selectionRect),
  } as unknown as EditorView;
}

describe("selectionRectIsVisible", () => {
  it("accepts a selection fully inside the viewport", () => {
    expect(selectionRectIsVisible(rect(20, 40), rect(0, 100))).toBe(true);
  });

  it("rejects a selection outside the viewport", () => {
    expect(selectionRectIsVisible(rect(-10, 10), rect(0, 100))).toBe(false);
    expect(selectionRectIsVisible(rect(90, 110), rect(0, 100))).toBe(false);
  });
});

describe("handleScrollToVisibleSelection", () => {
  it("handles ProseMirror scroll when the caret is already visible", () => {
    const view = viewWithRects(rect(20, 40), rect(0, 100));

    expect(handleScrollToVisibleSelection(view)).toBe(true);
    expect(view.coordsAtPos).toHaveBeenCalledWith(7, 1);
  });

  it("lets ProseMirror scroll when the caret is outside the content viewport", () => {
    const view = viewWithRects(rect(130, 150), rect(0, 100));

    expect(handleScrollToVisibleSelection(view)).toBe(false);
  });

  it("falls back to ProseMirror when no Woodshed content viewport is present", () => {
    const view = viewWithoutViewport(rect(20, 40));

    expect(handleScrollToVisibleSelection(view)).toBe(false);
  });
});
