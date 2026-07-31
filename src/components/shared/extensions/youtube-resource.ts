import { Node, mergeAttributes, nodePasteRule } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { MarkdownNodeSpec } from "tiptap-markdown";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import type { Node as PMNode } from "prosemirror-model";
import { YoutubeResourceView } from "./youtube-resource-view";

// Matches the YouTube URL shapes a "copy link" produces, capturing the 11-char
// video id as group 1. Covers: www/m/music subdomains, youtube-nocookie.com,
// `watch?v=` (with arbitrary params before `v=`, e.g. `watch?app=desktop&v=…`),
// `/embed/`, `/shorts/`, `/live/`, and `youtu.be/` short links — each with an
// optional trailing query (`?si=…`, `&t=…`). URL capture seeds a resource's
// body with the bare URL and the editor's load transform turns it into the
// embed (see replaceUrlParagraphsWithEmbeds), so this needs to recognise
// whatever the user pasted.
export const YOUTUBE_URL_RE =
  /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^\s]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&]\S*)?/i;

/// Tags that prefix a YouTube embed in the on-disk markdown. Order doesn't
/// matter — the post-load transform accepts either ordering. They are real
/// hashtags on disk and are surfaced visually as pills inside the rendered
/// embed container.
export const YOUTUBE_RESOURCE_TAG_LINE_RE =
  /^\s*(?:#resource\s+#youtube|#youtube\s+#resource)\s*$/;

/// Custom node that wraps a YouTube embed in a "resource card" — header
/// with the video's title and `#resource` / `#youtube` pills, then the
/// iframe below. Renders via a React NodeView so the title can be fetched
/// async (oEmbed) without blocking the editor.
///
/// Markdown round-trip:
///   serialize → "#resource #youtube\n\n<URL>\n\n"   (two real paragraphs)
///   parse     → see `replaceUrlParagraphsWithEmbeds` in tiptap-editor.tsx,
///               which collapses the prelude + URL into this node and also
///               upgrades bare URL paragraphs (legacy on-disk format).
export interface YoutubeResourceOptions {
  HTMLAttributes: Record<string, unknown>;
  addPasteHandler: boolean;
  /**
   * Fires when a PASTE creates this node — not when the post-load transform
   * rebuilds embeds from on-disk markdown. The editor host uses it to also
   * capture the video as a resource.
   */
  onPasted: ((url: string) => void) | null;
}

export const YoutubeResource = Node.create<YoutubeResourceOptions>({
  name: "youtubeResource",
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
      videoId: { default: null },
      // Cached oEmbed title. Lives in node attrs so navigating the doc
      // doesn't refetch on every render. NOT serialized to markdown.
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-youtube-resource]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // Plain HTML fallback (used during SSR / copy-as-html). The interactive
    // version is the React NodeView below.
    const url = HTMLAttributes.url as string | null;
    const videoId = HTMLAttributes.videoId as string | null;
    const wrapperAttrs = mergeAttributes(this.options.HTMLAttributes, {
      "data-youtube-resource": "",
      "data-url": url,
      "data-video-id": videoId,
    });
    if (!videoId) return ["div", wrapperAttrs];
    return [
      "div",
      wrapperAttrs,
      [
        "iframe",
        {
          src: `https://www.youtube.com/embed/${videoId}`,
          frameborder: "0",
          allowfullscreen: "true",
        },
      ],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(YoutubeResourceView);
  },

  addPasteRules() {
    if (!this.options.addPasteHandler) return [];
    return [
      nodePasteRule({
        find: new RegExp(YOUTUBE_URL_RE.source, "gi"),
        type: this.type,
        getAttributes: (match) => {
          this.options.onPasted?.(match[0]);
          return {
            url: match[0],
            videoId: match[1],
          };
        },
      }),
    ];
  },

  addStorage() {
    const spec: MarkdownNodeSpec = {
      serialize(state: MarkdownSerializerState, node: PMNode) {
        const url = node.attrs.url as string | null;
        if (!url) {
          state.closeBlock(node);
          return;
        }
        // Two real paragraphs in the markdown source: the tag prelude
        // (which makes the video index-able under #resource / #youtube
        // when tag tables land) followed by the URL (which the parser
        // round-trips back into this same node).
        state.write("#resource #youtube");
        state.closeBlock(node);
        state.write(url);
        state.closeBlock(node);
      },
      parse: {},
    };
    return { markdown: spec };
  },
});
