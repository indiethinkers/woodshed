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
  itemEnd: number;
  itemIndex: number;
  list: PMNode;
}

interface PostEmbedWritingBlockOptions {
  timestampedListItems: boolean;
}

interface EmbedInspection {
  cadenceActiveEmptyParagraphs: Array<{ from: number; to: number }>;
  cadenceStandaloneEmbeds: Array<{ from: number; to: number }>;
  trailingEmbed: TrailingEmbed | null;
}

function isSubstantive(node: PMNode): boolean {
  if (node.isText) return Boolean(node.textContent.trim());
  return node.isAtom && !NON_CONTENT_ATOMS.has(node.type.name);
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
      itemEnd: $pos.after(itemDepth),
      itemIndex: $pos.index(listDepth),
      list: $pos.node(listDepth),
    };
  }
  return null;
}

function hasSubstantiveContent(node: PMNode): boolean {
  if (isSubstantive(node)) return true;
  let substantive = false;
  node.descendants((child) => {
    if (isSubstantive(child)) substantive = true;
    return !substantive;
  });
  return substantive;
}

function isStandaloneCadenceEmbed(parent: PMNode, embed: PMNode): boolean {
  if (parent.type.name !== "listItem") return false;

  let embedCount = 0;
  let standalone = true;
  parent.forEach((child) => {
    if (EMBED_NODE_NAMES.has(child.type.name)) {
      embedCount += 1;
      if (child !== embed) standalone = false;
      return;
    }
    if (hasSubstantiveContent(child)) standalone = false;
  });
  return standalone && embedCount === 1;
}

function selectedEmptyParagraphIn(
  doc: PMNode,
  selectionFrom: number,
  listItem: PMNode,
): { from: number; to: number } | null {
  const $from = doc.resolve(selectionFrom);
  for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
    if ($from.node(depth) !== listItem) continue;
    const paragraphDepth = depth + 1;
    const paragraph = $from.node(paragraphDepth);
    if (
      paragraph.type.name !== "paragraph" ||
      hasSubstantiveContent(paragraph) ||
      paragraph.content.content.some(
        (child) => child.type.name === "dailyTimestamp",
      )
    ) {
      return null;
    }
    const from = $from.before(paragraphDepth);
    return { from, to: from + paragraph.nodeSize };
  }
  return null;
}

function emptyLeadParagraph(node: PMNode | null | undefined): PMNode | null {
  if (
    node?.type.name !== "listItem" ||
    node.childCount !== 1 ||
    node.firstChild?.type.name !== "paragraph" ||
    hasSubstantiveContent(node.firstChild)
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
function inspectEmbeds(
  doc: PMNode,
  timestampedListItems: boolean,
  selectionFrom: number,
): EmbedInspection {
  const cadenceActiveEmptyParagraphs: Array<{ from: number; to: number }> = [];
  const cadenceStandaloneEmbeds: Array<{ from: number; to: number }> = [];
  const candidates: TrailingEmbed[] = [];
  let lastSubstantivePos = -1;

  doc.descendants((node, pos, parent, index) => {
    if (isSubstantive(node)) lastSubstantivePos = pos;

    if (!EMBED_NODE_NAMES.has(node.type.name) || !parent) return;
    const paragraph = doc.type.schema.nodes.paragraph;
    if (!paragraph) return;

    const listItem = timestampedListItems
      ? topLevelListItemAt(doc, pos)
      : null;
    if (listItem) {
      if (isStandaloneCadenceEmbed(parent, node)) {
        cadenceStandaloneEmbeds.push({
          from: pos,
          to: pos + node.nodeSize,
        });
        const activeParagraph = selectedEmptyParagraphIn(
          doc,
          selectionFrom,
          parent,
        );
        if (activeParagraph) {
          cadenceActiveEmptyParagraphs.push(activeParagraph);
        }
      }
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
  return {
    cadenceActiveEmptyParagraphs,
    cadenceStandaloneEmbeds,
    trailingEmbed:
      candidate?.nodePos === lastSubstantivePos ? candidate : null,
  };
}

function insertWritingBlock(
  view: EditorView,
  getPos: () => number | undefined,
  timestampedListItems: boolean,
): void {
  const insertPos = getPos();
  if (insertPos == null) return;

  const listItemContext = timestampedListItems
    ? topLevelListItemAt(view.state.doc, insertPos)
    : null;
  if (listItemContext) {
    const listItem = view.state.schema.nodes.listItem?.createAndFill();
    if (!listItem) return;

    const transaction = view.state.tr;
    const itemEnd = listItemContext.itemEnd;
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
  if (
    !$insert.parent.canReplaceWith(
      $insert.index(),
      $insert.index(),
      paragraph.type,
    )
  ) {
    return;
  }

  const transaction = view.state.tr.insert(insertPos, paragraph);
  transaction.setSelection(
    TextSelection.near(transaction.doc.resolve(insertPos + 1), 1),
  );
  transaction.setMeta("skipDailyTimestamp", true);
  view.dispatch(transaction.scrollIntoView());
  view.focus();
}

function createWritingButton(
  view: EditorView,
  getPos: () => number | undefined,
  timestampedListItems: boolean,
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
    insertWritingBlock(view, getPos, timestampedListItems);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    insertWritingBlock(view, getPos, timestampedListItems);
  });
  return button;
}

/**
 * Paint a clickable writing affordance after the final embed without adding
 * derived content to the Markdown document. Clicking it creates a real empty
 * block and places the caret there. In Cadence that block must be a sibling
 * list item so its spacing and timestamp behavior match every other entry.
 */
export const PostEmbedWritingBlock = Extension.create<PostEmbedWritingBlockOptions>({
  name: "postEmbedWritingBlock",

  addOptions() {
    return { timestampedListItems: false };
  },

  addProseMirrorPlugins() {
    const { timestampedListItems } = this.options;
    return [
      new Plugin({
        key: postEmbedWritingBlockKey,
        props: {
          decorations(state) {
            const {
              cadenceActiveEmptyParagraphs,
              cadenceStandaloneEmbeds,
              trailingEmbed,
            } = inspectEmbeds(
              state.doc,
              timestampedListItems,
              state.selection.from,
            );
            const decorations = cadenceStandaloneEmbeds.map(({ from, to }) =>
              Decoration.node(from, to, {
                class: "cadence-standalone-embed",
              }),
            );
            decorations.push(
              ...cadenceActiveEmptyParagraphs.map(({ from, to }) =>
                Decoration.node(from, to, {
                  class: "cadence-active-empty-paragraph",
                }),
              ),
            );
            if (trailingEmbed?.target.kind === "paragraph") {
              decorations.push(
                Decoration.node(
                  trailingEmbed.target.from,
                  trailingEmbed.target.to,
                  {
                    class: "post-embed-writing-block",
                    "data-post-embed-writing-block": "",
                    "data-placeholder": "Start writing...",
                  },
                ),
              );
            } else if (trailingEmbed) {
              decorations.push(
                Decoration.widget(
                  trailingEmbed.target.pos,
                  (view, getPos) =>
                    createWritingButton(view, getPos, timestampedListItems),
                  { side: 1, ignoreSelection: true },
                ),
              );
            }
            return decorations.length
              ? DecorationSet.create(state.doc, decorations)
              : null;
          },
        },
      }),
    ];
  },
});
