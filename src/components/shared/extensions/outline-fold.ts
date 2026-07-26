import type { Editor } from "@tiptap/core";
import { ListItem } from "@tiptap/extension-list";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import type { MarkdownNodeSpec } from "tiptap-markdown";
import { outlineNormalizerPlugin } from "../outline-normalizer";

/**
 * Roam/Logseq-style collapsible bullets for outline-mode editors.
 *
 * Collapse state lives as a boolean `collapsed` attribute on `listItem` — not
 * as an in-content node, so it never interferes with caret/typing. On disk it
 * round-trips as a trailing HTML comment on the bullet's own text line:
 *
 *     - Parent thought <!-- collapsed -->
 *         - hidden child
 *
 * The comment is invisible in Obsidian/most viewers, so the vault stays
 * portable. Serialization is handled here (a `listItem` markdown serializer
 * that appends the marker); parsing is handled by `parseCollapsedMarkers`,
 * run post-load by the editor — markdown-it leaves the comment as trailing
 * paragraph text, which this lifts back into the attribute.
 *
 * Replaces StarterKit's `listItem` in outline mode (StarterKit is configured
 * with `listItem: false`), so it inherits the standard list keymap
 * (Enter/Tab/Shift-Tab) while adding the collapse attribute, serializer, and
 * fold-affordance plugin.
 */

const COLLAPSED_MARKER = "<!-- collapsed -->";
/** Strips a trailing collapse marker (with any leading/trailing whitespace)
 *  from a bullet's text so re-serialization re-adds exactly one space — no
 *  whitespace accumulation across save/load cycles. */
const COLLAPSED_MARKER_RE = /\s*<!--\s*collapsed\s*-->\s*$/;

/** Whether a list item contains a nested list — only such items can fold. */
function hasChildList(node: PMNode): boolean {
  let found = false;
  node.forEach((child) => {
    if (child.type.name === "bulletList" || child.type.name === "orderedList") {
      found = true;
    }
  });
  return found;
}

export const OutlineListItem = ListItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      collapsed: {
        default: false,
        // Internal-only: the fold plugin paints `data-collapsed` via a node
        // decoration (so it can paint `data-has-children` in the same pass),
        // and the markdown serializer carries it to disk. Splitting a bullet
        // (Enter) must not inherit the parent's collapse onto the new row.
        rendered: false,
        keepOnSplit: false,
      },
    };
  },

  addStorage() {
    const spec: MarkdownNodeSpec = {
      serialize(state: MarkdownSerializerState, node: PMNode) {
        // Only persist the marker when the item can actually fold — keeps a
        // stale `collapsed` flag on a childless item out of the file.
        if (!(node.attrs.collapsed === true && hasChildList(node))) {
          state.renderContent(node);
          return;
        }
        // Mirror prosemirror-markdown's list_item (render every child), but
        // splice the marker onto the bullet's own text line — after the first
        // block, before any nested list.
        node.forEach((child, _offset, index) => {
          if (index === 0 && child.isTextblock) {
            state.renderInline(child);
            state.write(` ${COLLAPSED_MARKER}`);
            state.closeBlock(child);
          } else {
            state.render(child, node, index);
          }
        });
      },
      parse: {
        // Markers arrive as trailing paragraph text; `parseCollapsedMarkers`
        // lifts them into the attribute after the doc is built.
      },
    };
    return { ...this.parent?.(), markdown: spec };
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Tab: () => {
        this.editor.commands.sinkListItem(this.name);
        return true;
      },
      "Shift-Tab": () => {
        if (selectionIsInTopLevelListItem(this.editor)) return true;
        return this.editor.commands.liftListItem(this.name);
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      outlineFoldPlugin(),
      outlineNormalizerPlugin(),
    ];
  },
});

function selectionIsInTopLevelListItem(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 1; depth -= 1) {
    if ($from.node(depth).type.name !== "listItem") continue;
    const list = $from.node(depth - 1);
    const parent = $from.node(depth - 2);
    return (
      (list.type.name === "bulletList" || list.type.name === "orderedList") &&
      parent.type.name === "doc"
    );
  }
  return false;
}

const outlineFoldPluginKey = new PluginKey("outlineFold");

function outlineFoldPlugin(): Plugin {
  return new Plugin({
    key: outlineFoldPluginKey,
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name !== "listItem") return true;
          if (!hasChildList(node)) return true;
          const collapsed = node.attrs.collapsed === true;
          decos.push(
            Decoration.node(pos, pos + node.nodeSize, {
              "data-has-children": "",
              ...(collapsed ? { "data-collapsed": "" } : {}),
            }),
          );
          // Caret sits at the very start of the item's content; CSS lifts it
          // over the row's dash. `getPos` keeps the toggle bound to the live
          // position even as the doc above it changes.
          decos.push(
            Decoration.widget(
              pos + 1,
              (view, getPos) => createFoldToggle(view, getPos, collapsed),
              {
                side: -1,
                ignoreSelection: true,
              },
            ),
          );
          return true;
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

function createFoldToggle(
  view: EditorView,
  getPos: () => number | undefined,
  collapsed: boolean,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "outline-fold-toggle";
  button.setAttribute("contenteditable", "false");
  button.setAttribute("aria-label", "Toggle children");
  button.setAttribute("aria-expanded", String(!collapsed));
  button.tabIndex = -1;
  // mousedown (not click) + preventDefault keeps the editor focused and the
  // caret put — the toggle is chrome, not a content interaction.
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const widgetPos = getPos();
    if (widgetPos == null) return;
    const itemPos = widgetPos - 1;
    const item = view.state.doc.nodeAt(itemPos);
    if (!item || item.type.name !== "listItem") return;
    const tr = view.state.tr.setNodeAttribute(
      itemPos,
      "collapsed",
      !(item.attrs.collapsed === true),
    );
    // Folding isn't a content edit — keep it off the undo stack.
    tr.setMeta("addToHistory", false);
    view.dispatch(tr);
  });
  return button;
}

/**
 * Lift trailing `<!-- collapsed -->` markers (left as plain text by markdown-it
 * on load) into the `collapsed` attribute, stripping the marker text. Run after
 * the outline normalization so positions are stable. Edits are excluded from
 * history (loading a file is not an undoable edit).
 */
export function parseCollapsedMarkers(editor: Editor): void {
  const { state } = editor;
  const listItemType = state.schema.nodes.listItem;
  if (!listItemType) return;

  const edits: { itemPos: number; from: number; to: number }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type !== listItemType) return true;
    const paragraph = node.firstChild;
    if (!paragraph || !paragraph.isTextblock) return true;
    const match = paragraph.textContent.match(COLLAPSED_MARKER_RE);
    if (!match) return true;
    // End of the paragraph's inline content: listItem at `pos`, paragraph
    // opens at pos+1, its content at pos+2. The marker is plain text at the
    // tail, so its char length equals its position span.
    const contentEnd = pos + 2 + paragraph.content.size;
    edits.push({
      itemPos: pos,
      from: contentEnd - match[0].length,
      to: contentEnd,
    });
    return true;
  });
  if (edits.length === 0) return;

  const tr = state.tr;
  // Apply high → low so earlier positions stay valid as later ranges drop.
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i];
    tr.delete(edit.from, edit.to);
    tr.setNodeAttribute(edit.itemPos, "collapsed", true);
  }
  tr.setMeta("addToHistory", false);
  if (tr.docChanged) editor.view.dispatch(tr);
}
