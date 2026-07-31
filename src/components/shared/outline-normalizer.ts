import { Fragment, type Node as PMNode } from "prosemirror-model";
import type { Editor } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";

/**
 * Wrap loose top-level content (paragraphs, headings, code blocks,
 * blockquotes, dividers — anything not already a list) into a single
 * `bulletList > listItem > <node>` so the doc reads as an outline.
 *
 * Why a normalizer instead of forcing the schema's top-level content
 * spec to `bulletList+`? Because schema-forcing fights ProseMirror on
 * every paste/setContent — pasted markdown lands as paragraphs, an
 * external-edit watcher event re-sets the content, and each round
 * triggers schema-coercion that silently drops or flattens content. A
 * normalizer is lossless: it accepts any markdown, then restructures.
 *
 * Lossless / reversible:
 *   - A paragraph-only daily journal becomes `- thing`-bullets on first
 *     load. The disk file gets `- thing` on next save (`tiptap-markdown`
 *     serializes bulletList natively).
 *   - Switching the editor back to freeform mode renders the same
 *     `- thing` markdown as a list visually — no data loss.
 *
 * Adjacent loose nodes collapse into a SINGLE bulletList rather than
 * many one-item lists, so the markdown stays compact (`- a\n- b`
 * rather than `- a\n\n- b`).
 *
 * No-op when:
 *   - The schema doesn't have `bulletList` / `listItem` / `paragraph`
 *     (defensive — should never happen with StarterKit installed).
 *   - The doc already consists only of top-level lists.
 *
 * Empty doc → starts with a single empty bullet so the user has
 * something to type into.
 */
export function normalizeToOutline(editor: Editor): void {
  const { state } = editor;
  const { doc, schema } = state;

  const normalized = normalizedOutlineContent(doc, schema);
  if (!normalized.changed) return;

  // Build the replacement doc node and swap it in. Going through a fresh
  // doc node (rather than `tr.replaceWith` against the existing doc) avoids
  // ProseMirror's content-spec auto-append behavior, which would otherwise
  // pad the result with a trailing empty paragraph in some configurations.
  const newDoc = doc.type.create(doc.attrs, normalized.content);
  const tr = state.tr.replaceWith(0, doc.content.size, newDoc.content);
  if (tr.docChanged) {
    tr.setMeta("skipDailyTimestamp", true);
    editor.view.dispatch(tr);
  }
}

export function outlineNormalizerPlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      if (transactions.some((tr) => tr.getMeta("skipOutlineNormalizer"))) {
        return null;
      }

      const normalized = normalizedOutlineContent(newState.doc, newState.schema);
      if (!normalized.changed) return null;

      const tr = newState.tr.replaceWith(
        0,
        newState.doc.content.size,
        newState.doc.type.create(newState.doc.attrs, normalized.content).content,
      );
      tr.setMeta("skipDailyTimestamp", true);
      tr.setMeta("skipOutlineNormalizer", true);
      tr.setMeta("addToHistory", false);

      const pos = Math.max(
        0,
        Math.min(newState.selection.to, tr.doc.content.size),
      );
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos), -1));
      return tr;
    },
  });
}

function normalizedOutlineContent(
  doc: PMNode,
  schema: Editor["schema"],
): { changed: boolean; content: Fragment } {
  const bulletListType = schema.nodes.bulletList;
  const orderedListType = schema.nodes.orderedList;
  const listItemType = schema.nodes.listItem;
  const paragraphType = schema.nodes.paragraph;
  if (!bulletListType || !listItemType || !paragraphType) {
    return { changed: false, content: doc.content };
  }

  // "Empty" means: zero children, or a single empty paragraph (Tiptap's
  // default seed for an empty document).
  const isEmpty =
    doc.childCount === 0 ||
    (doc.childCount === 1 &&
      doc.firstChild?.type === paragraphType &&
      doc.firstChild.content.size === 0);

  if (isEmpty) {
    const emptyItem = listItemType.create(null, paragraphType.create());
    return {
      changed: true,
      content: Fragment.fromArray([bulletListType.create(null, emptyItem)]),
    };
  }

  let hasLooseTopLevelContent = false;
  doc.forEach((child) => {
    if (
      child.type !== bulletListType &&
      (orderedListType ? child.type !== orderedListType : true)
    ) {
      hasLooseTopLevelContent = true;
    }
  });

  if (!hasLooseTopLevelContent) {
    return compactOutlineLists(doc);
  }

  const newChildren: PMNode[] = [];
  let pending: PMNode[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    newChildren.push(bulletListType.create(null, Fragment.fromArray(pending)));
    pending = [];
  };

  doc.forEach((child) => {
    const isList =
      child.type === bulletListType ||
      (orderedListType && child.type === orderedListType);
    if (isList) {
      flush();
      newChildren.push(child);
      return;
    }
    let item: PMNode;
    try {
      item = listItemType.create(null, child);
    } catch {
      const text = child.textContent;
      const para = paragraphType.create(
        null,
        text ? schema.text(text) : Fragment.empty,
      );
      item = listItemType.create(null, para);
    }
    pending.push(item);
  });
  flush();

  const compacted = compactOutlineNodes(newChildren);
  return { changed: true, content: Fragment.fromArray(compacted.nodes) };
}

function compactOutlineLists(doc: PMNode): {
  changed: boolean;
  content: Fragment;
} {
  const compacted = compactOutlineNodes([...doc.content.content]);
  return {
    changed: compacted.changed,
    content: compacted.changed ? Fragment.fromArray(compacted.nodes) : doc.content,
  };
}

function compactOutlineNodes(nodes: PMNode[]): {
  changed: boolean;
  nodes: PMNode[];
} {
  let changed = false;
  const merged: PMNode[] = [];

  for (const child of nodes) {
    const nextChild =
      isOutlineList(child) && child.attrs.tight === false
        ? child.type.create(tightListAttrs(child), child.content)
        : child;
    if (nextChild !== child) changed = true;

    const last = merged.at(-1);
    if (last && isOutlineList(last) && last.type === nextChild.type) {
      merged[merged.length - 1] = last.type.create(
        tightListAttrs(last),
        last.content.append(nextChild.content),
      );
      changed = true;
      continue;
    }
    merged.push(nextChild);
  }

  return { changed, nodes: merged };
}

function isOutlineList(node: PMNode): boolean {
  return node.type.name === "bulletList" || node.type.name === "orderedList";
}

function tightListAttrs(node: PMNode): Record<string, unknown> {
  return Object.prototype.hasOwnProperty.call(node.attrs, "tight")
    ? { ...node.attrs, tight: true }
    : node.attrs;
}
