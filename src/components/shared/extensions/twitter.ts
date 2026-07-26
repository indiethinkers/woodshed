import { Node, mergeAttributes, nodePasteRule } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { MarkdownNodeSpec } from "tiptap-markdown";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import type { Node as PMNode } from "prosemirror-model";
import { TWEET_URL_RE } from "@/lib/twitter";
import { TwitterView } from "./twitter-view";

/**
 * Twitter / X embed node.
 *
 * Renders as a static local card. The post opens in the system browser only
 * after a click; the editor never loads X scripts or frames. Markdown
 * round-trip is just the original tweet URL on its own line, so other tools
 * and the read-only renderer keep working unchanged.
 */
export interface TwitterOptions {
  HTMLAttributes: Record<string, unknown>;
  addPasteHandler: boolean;
  /**
   * Fires when a PASTE creates this node — not when the post-load transform
   * rebuilds embeds from on-disk markdown. The editor host uses it to also
   * capture the post as a resource.
   */
  onPasted: ((url: string) => void) | null;
}

export const Twitter = Node.create<TwitterOptions>({
  name: "twitter",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      addPasteHandler: true,
      onPasted: null,
    };
  },

  addAttributes() {
    return {
      url: { default: null },
      tweetId: { default: null },
      handle: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-tweet-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const tweetId = HTMLAttributes.tweetId as string | null;
    const url = HTMLAttributes.url as string | null;
    const handle = HTMLAttributes.handle as string | null;
    const wrapperAttrs = mergeAttributes(
      this.options.HTMLAttributes,
      {
        "data-tweet-id": tweetId,
        "data-tweet-url": url,
        "data-tweet-handle": handle,
        class:
          "tweet-embed twitter-embed-shell",
      },
    );
    if (!tweetId) {
      return ["div", wrapperAttrs];
    }
    return [
      "div",
      wrapperAttrs,
      ["a", { href: url, target: "_blank", rel: "noreferrer" }, "View post on X"],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TwitterView);
  },

  addPasteRules() {
    if (!this.options.addPasteHandler) return [];
    return [
      nodePasteRule({
        find: new RegExp(TWEET_URL_RE.source, "gi"),
        type: this.type,
        getAttributes: (match) => {
          this.options.onPasted?.(match[0]);
          return {
            url: match[0],
            tweetId: match[2],
            handle: match[1],
          };
        },
      }),
    ];
  },

  addStorage() {
    const spec: MarkdownNodeSpec = {
      serialize(state: MarkdownSerializerState, node: PMNode) {
        const url = node.attrs.url as string | null;
        if (url) state.write(url);
        state.closeBlock(node);
      },
      parse: {},
    };
    return { markdown: spec };
  },
});
