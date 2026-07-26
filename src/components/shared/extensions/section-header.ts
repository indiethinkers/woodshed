import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "prosemirror-model";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import type { MarkdownNodeSpec } from "tiptap-markdown";

export interface SectionHeaderOptions {
  HTMLAttributes: Record<string, unknown>;
}

/**
 * Visual section divider: uppercase label on the left, rule on the right.
 *
 * Markdown round-trip uses H6 (`###### Notes`) so the vault stays readable
 * in plain markdown while Woodshed can render the distinctive section style.
 */
export const SectionHeader = Node.create<SectionHeaderOptions>({
  name: "sectionHeader",

  group: "block",
  content: "inline*",
  defining: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  parseHTML() {
    return [{ tag: "h6" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "h6",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-section-header": "",
      }),
      0,
    ];
  },

  addStorage() {
    const spec: MarkdownNodeSpec = {
      serialize(state: MarkdownSerializerState, node: PMNode) {
        state.write("###### ");
        state.renderInline(node);
        state.closeBlock(node);
      },
      parse: {},
    };
    return { markdown: spec };
  },
});
