import type { EditorView } from "@tiptap/pm/view";

const CONTENT_SCROLL_SELECTOR = "[data-woodshed-content-scroll]";

type RectLike = Pick<DOMRect, "top" | "right" | "bottom" | "left">;

export function selectionRectIsVisible(
  selection: RectLike,
  viewport: RectLike,
): boolean {
  return (
    selection.top >= viewport.top &&
    selection.bottom <= viewport.bottom &&
    selection.left >= viewport.left &&
    selection.right <= viewport.right
  );
}

export function handleScrollToVisibleSelection(view: EditorView): boolean {
  const viewport = view.dom.closest<HTMLElement>(CONTENT_SCROLL_SELECTOR);
  if (!viewport) return false;

  let selectionRect: RectLike;
  try {
    selectionRect = view.coordsAtPos(view.state.selection.head, 1);
  } catch {
    return false;
  }

  if (!selectionRectIsVisible(selectionRect, viewport.getBoundingClientRect())) {
    return false;
  }

  return true;
}
