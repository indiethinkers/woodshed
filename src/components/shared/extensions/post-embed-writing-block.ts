import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

const postEmbedWritingBlockKey = new PluginKey("postEmbedWritingBlock");
const EMBED_NODE_NAMES = new Set(["twitter", "youtubeResource"]);
const NON_CONTENT_ATOMS = new Set(["dailyTimestamp", "hardBreak"]);

interface TrailingEmbed {
  nodePos: number;
  target:
    | { kind: "insert"; pos: number }
    | { kind: "paragraph"; from: number; to: number };
}

interface TopLevelListItemContext {
  itemDepth: number;
  itemEnd: number;
  itemIndex: number;
  list: PMNode;
}

function topLevelListItemAt(
  doc: PMNode,
  pos: number,
): TopLevelListItemContext | null {
  const $pos = doc.resolve(pos);
  for (let itemDepth = $pos.depth; itemDepth > 0; itemDepth -= 1) {
    if ($pos.node(itemDepth).type.name !== "listItem") continue;

    const listDepth = itemDepth - 1;
    if (
      listDepth !== 1 ||
      $pos.node(listDepth).type.name !== "bulletList" ||
      $pos.node(0).type.name !== "doc"
    ) {
      return null;
    }

    return {
      itemDepth,
      itemEnd: $pos.after(itemDepth),
      itemIndex: $pos.index(listDepth),
      list: $pos.node(listDepth),
    };
  }
  return null;
}

function emptyLeadParagraph(node: PMNode | null | undefined): PMNode | null {
  if (
    node?.type.name !== "listItem" ||
    node.childCount !== 1 ||
    node.firstChild?.type.name !== "paragraph" ||
    node.firstChild.content.size !== 0
  ) {
    return null;
  }
  return node.firstChild;
}

/**
 * Locate an embed only when it is the document's last substantive block.
 *
 * Cadence embeds live inside list items, so checking only the embed's direct
 * parent is insufficient: a later list item may already contain text. Empty
 * outline rows and timestamp atoms do not suppress the affordance, but any
 * later text, media, rule, or embed does.
 */
function findTrailingEmbed(doc: PMNode): TrailingEmbed | null {
  const candidates: TrailingEmbed[] = [];
  let lastSubstantivePos = -1;

  doc.descendants((node, pos, parent, index) => {
    if (node.isText) {
      if (node.textContent.trim()) lastSubstantivePos = pos;
      return;
    }

    if (node.isAtom && !NON_CONTENT_ATOMS.has(node.type.name)) {
      lastSubstantivePos = pos;
    }

    if (!EMBED_NODE_NAMES.has(node.type.name) || !parent) return;
    const paragraph = doc.type.schema.nodes.paragraph;
    if (!paragraph) return;

    const listItem = topLevelListItemAt(doc, pos);
    if (listItem) {
      const nextParagraph = emptyLeadParagraph(
        listItem.list.maybeChild(listItem.itemIndex + 1),
      );
      if (nextParagraph) {
        const from = listItem.itemEnd + 1;
        candidates.push({
          nodePos: pos,
          target: { kind: "paragraph", from, to: from + nextParagraph.nodeSize },
        });
        return;
      }

      if (listItem.itemIndex + 1 === listItem.list.childCount) {
        candidates.push({
          nodePos: pos,
          target: { kind: "insert", pos: pos + node.nodeSize },
        });
      }
      return;
    }

    const insertIndex = index + 1;
    const nextSibling = parent.maybeChild(insertIndex);
    if (nextSibling?.type === paragraph && nextSibling.content.size === 0) {
      const from = pos + node.nodeSize;
      candidates.push({
        nodePos: pos,
        target: { kind: "paragraph", from, to: from + nextSibling.nodeSize },
      });
      return;
    }
    if (
      insertIndex !== parent.childCount ||
      !parent.canReplaceWith(insertIndex, insertIndex, paragraph)
    ) {
      return;
    }
    candidates.push({
      nodePos: pos,
      target: { kind: "insert", pos: pos + node.nodeSize },
    });
  });

  const candidate = candidates.at(-1);
  if (!candidate) return null;
  return candidate.nodePos === lastSubstantivePos ? candidate : null;
}

function insertWritingBlock(
  view: EditorView,
  getPos: () => number | undefined,
): void {
  const insertPos = getPos();
  if (insertPos == null) return;

  const listItemContext = topLevelListItemAt(view.state.doc, insertPos);
  if (listItemContext) {
    const listItem = view.state.schema.nodes.listItem?.createAndFill();
    if (!listItem) return;

    const transaction = view.state.tr;
    const $widget = view.state.doc.resolve(insertPos);
    const legacyParagraph = $widget.parent.maybeChild($widget.index());
    if (
      $widget.parent.type.name === "listItem" &&
      legacyParagraph?.type.name === "paragraph" &&
      legacyParagraph.content.size === 0
    ) {
      transaction.delete(insertPos, insertPos + legacyParagraph.nodeSize);
    }

    const itemEnd = transaction.mapping.map(listItemContext.itemEnd, 1);
    const $itemEnd = transaction.doc.resolve(itemEnd);
    if (
      !$itemEnd.parent.canReplaceWith(
        $itemEnd.index(),
        $itemEnd.index(),
        listItem.type,
      )
    ) {
      return;
    }

    transaction.insert(itemEnd, listItem);
    transaction.setSelection(
      TextSelection.near(transaction.doc.resolve(itemEnd + 2), 1),
    );
    view.dispatch(transaction.scrollIntoView());
    view.focus();
    return;
  }

  const paragraph = view.state.schema.nodes.paragraph?.createAndFill();
  if (!paragraph) return;

  const $insert = view.state.doc.resolve(insertPos);
  if (!$insert.parent.canReplaceWith($insert.index(), $insert.index(), paragraph.type)) {
    return;
  }

  const transaction = view.state.tr.insert(insertPos, paragraph);
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(insertPos + 1), 1));
  transaction.setMeta("skipDailyTimestamp", true);
  view.dispatch(transaction.scrollIntoView());
  view.focus();
}

function createWritingButton(
  view: EditorView,
  getPos: () => number | undefined,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "post-embed-writing-block";
  button.setAttribute("contenteditable", "false");
  button.setAttribute("data-post-embed-writing-block", "");
  button.setAttribute("aria-label", "Start writing after embed");
  button.textContent = "Start writing...";

  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    insertWritingBlock(view, getPos);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    insertWritingBlock(view, getPos);
  });
  return button;
}

/**
 * Paint a clickable writing affordance after the final embed without adding
 * derived content to the Markdown document. Clicking it creates a real empty
 * block and places the caret there. In Cadence that block must be a sibling
 * list item so its spacing and timestamp behavior match every other entry.
 */
export const PostEmbedWritingBlock = Extension.create({
  name: "postEmbedWritingBlock",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: postEmbedWritingBlockKey,
        props: {
          decorations(state) {
            const trailingEmbed = findTrailingEmbed(state.doc);
            if (!trailingEmbed) return null;
            if (trailingEmbed.target.kind === "paragraph") {
              return DecorationSet.create(state.doc, [
                Decoration.node(
                  trailingEmbed.target.from,
                  trailingEmbed.target.to,
                  {
                    class: "post-embed-writing-block",
                    "data-post-embed-writing-block": "",
                    "data-placeholder": "Start writing...",
                  },
                ),
              ]);
            }
            return DecorationSet.create(state.doc, [
              Decoration.widget(
                trailingEmbed.target.pos,
                (view, getPos) => createWritingButton(view, getPos),
                { side: 1, ignoreSelection: true },
              ),
            ]);
          },
        },
      }),
    ];
  },
});
