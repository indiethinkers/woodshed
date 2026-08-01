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

function insertParagraph(
  view: EditorView,
  getPos: () => number | undefined,
): void {
  const insertPos = getPos();
  const paragraph = view.state.schema.nodes.paragraph?.createAndFill();
  if (insertPos == null || !paragraph) return;

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
    insertParagraph(view, getPos);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    insertParagraph(view, getPos);
  });
  return button;
}

/**
 * Paint a clickable writing affordance after the final embed without adding
 * derived content to the Markdown document. Clicking it creates a real empty
 * paragraph and places the caret there.
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
