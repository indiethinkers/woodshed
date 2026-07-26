import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

type Direction = "up" | "down";

export function handleBlockArrowNavigation(
  view: EditorView,
  event: KeyboardEvent,
): boolean {
  const direction = arrowDirection(event);
  if (!direction) return false;

  const nextSelection = adjacentBlockSelection(view, direction);
  if (!nextSelection) return false;

  event.preventDefault();
  view.dispatch(view.state.tr.setSelection(nextSelection).scrollIntoView());
  return true;
}

function arrowDirection(event: KeyboardEvent): Direction | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return null;
  }
  if (event.key === "ArrowUp") return "up";
  if (event.key === "ArrowDown") return "down";
  return null;
}

function adjacentBlockSelection(
  view: EditorView,
  direction: Direction,
): NodeSelection | TextSelection | null {
  const { doc, selection } = view.state;

  if (selection instanceof NodeSelection) {
    return selectionFromSelectedNode(doc, selection, direction);
  }
  if (!(selection instanceof TextSelection) || !selection.empty) return null;

  const { $from } = selection;
  if (!$from.parent.isTextblock) return null;
  if (direction === "up" && $from.parentOffset !== 0) return null;
  if (direction === "down" && $from.parentOffset !== $from.parent.content.size) {
    return null;
  }

  const blockDepth = $from.depth;
  if (blockDepth === 0) return null;

  const parentDepth = blockDepth - 1;
  const parent = $from.node(parentDepth);
  const index = $from.index(parentDepth);
  const currentStart = $from.before(blockDepth);
  const currentEnd = $from.after(blockDepth);

  if (direction === "up") {
    if (index === 0) return null;
    const prev = parent.child(index - 1);
    return selectionForAdjacentNode(doc, prev, currentStart - prev.nodeSize, "end");
  }

  if (index >= parent.childCount - 1) return null;
  const next = parent.child(index + 1);
  return selectionForAdjacentNode(doc, next, currentEnd, "start");
}

function selectionFromSelectedNode(
  doc: PMNode,
  selection: NodeSelection,
  direction: Direction,
): NodeSelection | TextSelection | null {
  const { $from } = selection;
  const parent = $from.parent;
  const index = $from.index();

  if (direction === "up") {
    if (index === 0) return null;
    const prev = parent.child(index - 1);
    return selectionForAdjacentNode(doc, prev, selection.from - prev.nodeSize, "end");
  }

  if (index >= parent.childCount - 1) return null;
  const next = parent.child(index + 1);
  return selectionForAdjacentNode(doc, next, selection.to, "start");
}

function selectionForAdjacentNode(
  doc: PMNode,
  node: PMNode,
  pos: number,
  side: "start" | "end",
): NodeSelection | TextSelection | null {
  if (node.isAtom && node.isBlock && NodeSelection.isSelectable(node)) {
    return NodeSelection.create(doc, pos);
  }
  if (!node.isTextblock || node.content.size > 0) return null;
  return TextSelection.create(doc, side === "start" ? pos + 1 : textblockEnd(pos, node));
}

function textblockEnd(pos: number, node: PMNode): number {
  return pos + 1 + node.content.size;
}
