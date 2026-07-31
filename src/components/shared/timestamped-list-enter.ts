import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { Fragment, type Node as PMNode } from "prosemirror-model";

export function insertTopLevelItemAfterChildren(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  let itemDepth: number | null = null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "listItem") {
      itemDepth = depth;
      break;
    }
  }
  if (itemDepth === null || itemDepth < 2) return false;

  const item = $from.node(itemDepth);
  const list = $from.node(itemDepth - 1);
  const listParent = $from.node(itemDepth - 2);
  const paragraph = item.firstChild;
  const isTopLevel =
    (list.type.name === "bulletList" || list.type.name === "orderedList") &&
    listParent.type.name === "doc";
  const isAtEndOfParentLine =
    paragraph === $from.parent && $from.parentOffset === paragraph.content.size;
  const hasChildren = item.content.content.some(
    (child) =>
      child.type.name === "bulletList" || child.type.name === "orderedList",
  );
  if (!isTopLevel || !isAtEndOfParentLine || !hasChildren) return false;

  const listItemType = state.schema.nodes.listItem;
  const nextItem = listItemType?.createAndFill();
  if (!nextItem) return false;

  const insertPos = $from.after(itemDepth);
  const tr = state.tr.insert(insertPos, nextItem);
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 2), 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * When an atom embed follows an empty lead paragraph in one daily list item,
 * splitting that paragraph can fail because the atom must stay in place.
 * Enter instead inserts a second paragraph above the embed and moves the
 * cursor there, so users can write multiple lines before the card.
 */
export function insertParagraphAboveTrailingEmbed(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.content.size !== 0) {
    return false;
  }

  let itemDepth: number | null = null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "listItem") {
      itemDepth = depth;
      break;
    }
  }
  if (itemDepth === null) return false;

  const item = $from.node(itemDepth);
  const paragraphIndex = $from.index(itemDepth);
  const trailingBlock = item.maybeChild(paragraphIndex + 1);
  if (!trailingBlock || !trailingBlock.isAtom || trailingBlock.isInline) {
    return false;
  }

  const paragraph = state.schema.nodes.paragraph?.createAndFill();
  if (!paragraph) return false;
  const insertPos = $from.before($from.depth);
  const tr = state.tr.insert(insertPos, paragraph);
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1), 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function deleteEmptyListItem(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  let itemDepth: number | null = null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "listItem") {
      itemDepth = depth;
      break;
    }
  }
  if (itemDepth === null || itemDepth < 2) return false;

  const item = $from.node(itemDepth);
  const listDepth = itemDepth - 1;
  const list = $from.node(listDepth);
  const itemStart = $from.before(itemDepth);
  const itemEnd = $from.after(itemDepth);

  if (listItemHasVisibleContent(item)) {
    if (listItemOwnBlockHasVisibleContent(item)) return false;
    const promoted = childListItems(item);
    if (promoted.length === 0) return false;

    const tr = state.tr.replaceWith(
      itemStart,
      itemEnd,
      Fragment.fromArray(promoted),
    );
    const pos = Math.max(
      0,
      Math.min(tr.mapping.map(itemStart, 1) + 2, tr.doc.content.size),
    );
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1));
    editor.view.dispatch(tr.scrollIntoView());
    return true;
  }

  let deleteFrom = itemStart;
  let deleteTo = itemEnd;
  let selectionPos = itemStart;

  if (list.childCount === 1) {
    if (listDepth <= 1) return false;
    const parentItemDepth = listDepth - 1;
    const parentItem = $from.node(parentItemDepth);
    const parentBlock = parentItem.firstChild;
    if (parentBlock?.isTextblock) {
      selectionPos = $from.before(parentItemDepth) + parentBlock.nodeSize;
    }
    deleteFrom = $from.before(listDepth);
    deleteTo = $from.after(listDepth);
  }

  const tr = state.tr.delete(deleteFrom, deleteTo);
  const pos = Math.max(
    0,
    Math.min(tr.mapping.map(selectionPos, -1), tr.doc.content.size),
  );
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos), -1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function deleteListItemTextBeforeCursor(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  let itemDepth: number | null = null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "listItem") {
      itemDepth = depth;
      break;
    }
  }
  if (itemDepth === null) return false;
  if (!$from.parent.isTextblock) return false;

  let from = $from.start($from.depth);
  const firstInline = $from.parent.firstChild;
  if (firstInline?.type.name === "dailyTimestamp") {
    from += firstInline.nodeSize;
  }

  if (selection.from <= from) {
    return listItemOwnBlockHasVisibleContent($from.node(itemDepth));
  }

  const tr = state.tr.delete(from, selection.from);
  tr.setSelection(TextSelection.create(tr.doc, from));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function outdentEmptyNestedListItem(editor: Editor): boolean {
  const context = currentListItemContext(editor);
  if (!context || context.isTopLevel) return false;
  if (listItemHasVisibleContent(context.item)) return false;
  return editor.commands.liftListItem("listItem");
}

export function outdentNestedListItem(editor: Editor): boolean {
  const context = currentListItemContext(editor);
  if (!context) return false;
  if (context.isTopLevel) return true;
  return editor.commands.liftListItem("listItem");
}

export function outdentListItemAtStart(editor: Editor): boolean {
  const context = currentListItemContext(editor);
  if (!context || context.isTopLevel) return false;
  if (!listItemHasVisibleContent(context.item)) return false;

  const { selection } = editor.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return false;

  let start = $from.start($from.depth);
  const firstInline = $from.parent.firstChild;
  if (firstInline?.type.name === "dailyTimestamp") {
    start += firstInline.nodeSize;
  }
  if (selection.from > start) return false;

  return editor.commands.liftListItem("listItem");
}

/** Turn a Markdown `- ` typed into a fresh timestamped top-level row into a
 * real nested bullet. The hidden timestamp atom means StarterKit's native
 * list input rule cannot see the marker at the start of the paragraph. */
export function nestTimestampedListMarker(editor: Editor): boolean {
  const context = currentListItemContext(editor);
  if (!context?.isTopLevel || context.item.childCount !== 1) return false;

  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  const paragraph = context.item.firstChild;
  const timestamp = paragraph?.firstChild;
  if (
    paragraph !== $from.parent ||
    timestamp?.type.name !== "dailyTimestamp" ||
    paragraph.textContent !== "-" ||
    $from.parentOffset !== paragraph.content.size
  ) {
    return false;
  }

  const listDepth = context.itemDepth - 1;
  if ($from.index(listDepth) === 0) return false;
  if (!editor.can().sinkListItem("listItem")) return false;

  const markerFrom = $from.start($from.depth) + timestamp.nodeSize;
  const tr = state.tr.delete(markerFrom, selection.from);
  tr.setSelection(TextSelection.create(tr.doc, markerFrom));
  editor.view.dispatch(tr);

  return editor.commands.sinkListItem("listItem");
}

/** Turn the third hyphen in a timestamped top-level row into a divider.
 * StarterKit's native `---` input rule is anchored to the start of the
 * paragraph, so the hidden DailyTimestamp atom prevents it from matching.
 * Typography may already have folded the first two hyphens into an em dash,
 * hence both marker shapes are accepted here. */
export function insertTimestampedHorizontalRule(editor: Editor): boolean {
  const context = currentListItemContext(editor);
  if (!context?.isTopLevel || context.item.childCount !== 1) return false;

  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  const paragraph = context.item.firstChild;
  const timestamp = paragraph?.firstChild;
  if (
    paragraph !== $from.parent ||
    timestamp?.type.name !== "dailyTimestamp" ||
    (paragraph.textContent !== "--" && paragraph.textContent !== "—") ||
    $from.parentOffset !== paragraph.content.size
  ) {
    return false;
  }

  const markerFrom = $from.start($from.depth) + timestamp.nodeSize;
  return editor
    .chain()
    .deleteRange({ from: markerFrom, to: selection.from })
    .setHorizontalRule()
    .run();
}

export function listItemHasVisibleContent(node: PMNode): boolean {
  let hasContent = false;

  node.descendants((child) => {
    if (hasContent) return false;
    if (child.type.name === "dailyTimestamp") return false;

    if (child.isText) {
      hasContent = (child.text ?? "").trim().length > 0;
      return !hasContent;
    }

    if (child.isInline) {
      hasContent = child.type.name !== "hardBreak";
      return !hasContent;
    }

    if (child.isAtom || child.isLeaf) {
      hasContent = true;
      return false;
    }

    return true;
  });

  return hasContent;
}

function currentListItemContext(editor: Editor): {
  item: PMNode;
  itemDepth: number;
  isTopLevel: boolean;
} | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;

  const { $from } = selection;
  let itemDepth: number | null = null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "listItem") {
      itemDepth = depth;
      break;
    }
  }
  if (itemDepth === null || itemDepth < 2) return null;

  const list = $from.node(itemDepth - 1);
  const parent = $from.node(itemDepth - 2);
  const isTopLevel =
    (list.type.name === "bulletList" || list.type.name === "orderedList") &&
    parent.type.name === "doc";

  return { item: $from.node(itemDepth), itemDepth, isTopLevel };
}

function listItemOwnBlockHasVisibleContent(item: PMNode): boolean {
  const block = item.firstChild;
  return block ? listItemHasVisibleContent(block) : false;
}

function childListItems(item: PMNode): PMNode[] {
  const children: PMNode[] = [];
  item.forEach((child, _offset, index) => {
    if (index === 0) return;
    if (child.type.name !== "bulletList" && child.type.name !== "orderedList") {
      return;
    }
    child.forEach((listItem) => {
      children.push(listItem);
    });
  });
  return children;
}
