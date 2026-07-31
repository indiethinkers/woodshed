import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { Node as PMNode } from "prosemirror-model";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import type { MarkdownNodeSpec } from "tiptap-markdown";
import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.js";
import { formatDailyTimestamp, isDailyTimestamp } from "@/lib/daily-timestamps";

interface DailyTimestampAttributes {
  time: string;
}

export const DailyTimestamp = Node.create({
  name: "dailyTimestamp",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      time: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-time") ?? "",
        renderHTML: (attrs) => {
          const time = (attrs as DailyTimestampAttributes).time;
          return time ? { "data-time": time } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-daily-timestamp]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-daily-timestamp": "",
        "aria-hidden": "true",
        contenteditable: "false",
      }),
    ];
  },

  renderText({ node }) {
    const time = (node.attrs as DailyTimestampAttributes).time;
    return time ? `[${time}]` : "";
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (transactions.some((tr) => tr.getMeta("skipDailyTimestamp"))) {
            return null;
          }
          const timestampType = newState.schema.nodes.dailyTimestamp;
          if (!timestampType) return null;

          const inserts: number[] = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== "listItem") return true;
            // Only top-level bullets carry a timestamp — nested outline rows
            // stay clean. A top-level list item resolves to depth 1 (its
            // parent bulletList is a direct child of the doc); nested rows sit
            // at depth 3+. Returning false skips the item's subtree so nested
            // items are never visited for stamping.
            if (newState.doc.resolve(pos).depth !== 1) return false;
            const paragraph = node.firstChild;
            if (paragraph?.type.name !== "paragraph") return false;
            if (paragraph.firstChild?.type === timestampType) return false;

            const oldNode = safeNodeAt(oldState.doc, pos);
            const gainedEmbed =
              containsTimestampedEmbed(node) &&
              !containsTimestampedEmbed(oldNode);

            // Empty blocks are intentional spacing and remain bare Markdown
            // bullets. A pasted embed is the exception: its required empty
            // lead paragraph carries the card's durable gutter timestamp.
            if (
              paragraph.textContent.trim().length === 0 &&
              !gainedEmbed
            ) {
              return false;
            }
            const oldParagraph = oldNode?.firstChild;
            if (!gainedEmbed) {
              if (oldParagraph?.type.name !== "paragraph") return false;
              if (oldParagraph.firstChild?.type === timestampType) return false;
              if (oldParagraph.textContent.trim().length !== 0) return false;
            }

            inserts.push(pos + 2);
            return false;
          });

          // Nested rows never carry a timestamp. When a top-level bullet is
          // sunk under another (Tab/indent), it drags its [HH:MM] node into the
          // nested row — strip it so the sub-bullet reads as a clean dash. The
          // listItem one level above the timestamp resolves to depth 1 only
          // when it's top-level (mirrors the stamping guard above).
          const removals: number[] = [];
          newState.doc.descendants((node, pos) => {
            if (node.type !== timestampType) return undefined;
            const $pos = newState.doc.resolve(pos);
            const itemDepth = $pos.depth - 1;
            if (
              itemDepth >= 1 &&
              $pos.node(itemDepth).type.name === "listItem" &&
              newState.doc.resolve($pos.before(itemDepth)).depth !== 1
            ) {
              removals.push(pos);
            }
            return undefined;
          });

          if (inserts.length === 0 && removals.length === 0) return null;

          const tr = newState.tr;
          const time = formatDailyTimestamp();
          // Apply highest-position edits first so the lower positions we still
          // need to touch don't shift out from under us. Inserts and removals
          // never target the same row, so ordering between them is irrelevant
          // beyond the descending-position rule.
          const edits = [
            ...inserts.map((pos) => ({ pos, kind: "insert" as const })),
            ...removals.map((pos) => ({ pos, kind: "delete" as const })),
          ].sort((a, b) => b.pos - a.pos);
          for (const edit of edits) {
            if (edit.kind === "insert") {
              tr.insert(edit.pos, timestampType.create({ time }));
            } else {
              tr.delete(edit.pos, edit.pos + 1);
            }
          }
          return tr;
        },
      }),
    ];
  },

  addStorage() {
    const spec: MarkdownNodeSpec = {
      serialize(state: MarkdownSerializerState, node: PMNode) {
        const time = (node.attrs as DailyTimestampAttributes).time;
        if (!time) return;
        state.write(`[${time}] `);
      },
      parse: {
        setup(md: MarkdownIt) {
          const installed = "__woodshedDailyTimestampInstalled" as const;
          const mdAny = md as unknown as Record<string, unknown>;
          if (mdAny[installed]) return;
          mdAny[installed] = true;

          md.inline.ruler.before(
            "text",
            "dailyTimestamp",
            (state: StateInline, silent: boolean) => {
              if (state.pos !== 0) return false;
              const match = state.src
                .slice(state.pos)
                .match(/^\[(\d{2}:\d{2})\][ \t]?/);
              if (!match || !isDailyTimestamp(match[1])) return false;

              if (!silent) {
                const token = state.push("dailyTimestamp", "", 0);
                token.content = match[1];
              }
              state.pos += match[0].length;
              return true;
            },
          );

          md.renderer.rules.dailyTimestamp = (tokens, idx) => {
            const safe = md.utils.escapeHtml(tokens[idx].content);
            return `<span data-daily-timestamp data-time="${safe}"></span>`;
          };
        },
      },
    };
    return { markdown: spec };
  },
});

function safeNodeAt(doc: PMNode, pos: number): PMNode | null {
  if (pos < 0 || pos > doc.content.size) return null;
  try {
    return doc.nodeAt(pos);
  } catch {
    return null;
  }
}

function containsTimestampedEmbed(node: PMNode | null): boolean {
  if (!node) return false;
  return node.content.content.some(
    (child) =>
      child.type.name === "twitter" || child.type.name === "youtubeResource",
  );
}
