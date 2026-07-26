import { Node, mergeAttributes, nodePasteRule, InputRule } from "@tiptap/core";
import type { MarkdownNodeSpec } from "tiptap-markdown";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import type { Node as PMNode } from "prosemirror-model";
import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.js";

export type WikilinkType =
  | "note"
  | "person"
  | "event"
  | "resource"
  | "task"
  | "area";

export interface WikilinkAttributes {
  /** The displayed text (the alias, when one is present). */
  text: string;
  /**
   * The page this link resolves to, when it differs from `text`. Null for a
   * plain `[[Name]]` (resolution falls back to `text`). Set for an aliased
   * `[[Target|display]]`, where `target` is what resolves/navigates and
   * `text` is what's shown.
   */
  target: string | null;
  type: WikilinkType | null;
}

/**
 * Split a wikilink's inner text (between the brackets) into its display
 * `text` and optional resolution `target`. Obsidian convention:
 * `[[Target|display]]` — left of the pipe resolves, right of it is shown.
 * A plain `[[Name]]` has no target (resolution falls back to the text).
 */
export function parseWikilinkInner(inner: string): {
  text: string;
  target: string | null;
} {
  const pipe = inner.indexOf("|");
  if (pipe === -1) return { text: inner.trim(), target: null };
  const target = inner.slice(0, pipe).trim();
  const text = inner.slice(pipe + 1).trim();
  return { text, target: target || null };
}

/** Inverse of `parseWikilinkInner` — emit `[[target|text]]` or `[[text]]`. */
export function serializeWikilink(text: string, target: string | null): string {
  if (target && target !== text) return `[[${target}|${text}]]`;
  return `[[${text}]]`;
}

/// Inline atom node representing `[[wikilink]]` in the editor.
///
/// Markdown round-trip:
///   serialize → "[[text]]"
///   parse     → markdown-it inline rule (registered before `link` so the
///               outer brackets aren't consumed as a ref-link), emitting
///               <a data-wikilink data-text="..."> which parseHTML matches.
///
/// Display styling matches the read-only `<Wikilink>` (warm-toned underline).
/// Resolution (whether the target exists in the vault) happens at render time
/// via a separate React hook in Phase 3 — for Phase 1 every wikilink in the
/// editor renders with the same underline regardless of resolution.
export const Wikilink = Node.create({
  name: "wikilink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (el) =>
          el.getAttribute("data-text") ?? el.textContent ?? "",
        renderHTML: (attrs) => ({
          "data-text": (attrs as WikilinkAttributes).text,
        }),
      },
      // Resolution target for an aliased link. Round-trips through markdown
      // as `[[target|text]]` (Obsidian-compatible); a null target serializes
      // as a plain `[[text]]`.
      target: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-target") || null,
        renderHTML: (attrs) => {
          const t = (attrs as WikilinkAttributes).target;
          return t ? { "data-target": t } : {};
        },
      },
      // Type is set by the picker when the user chooses "Create new note /
      // person / event / resource". It lives on the node only — markdown
      // serialization stays as plain `[[name]]` so external editors are
      // unaffected. Carries the picker's intent through to the rendered
      // node; the actual file write happens at picker-commit time (see
      // WikilinkPicker `commit`), not on first navigation.
      type: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-type") || null,
        renderHTML: (attrs) => {
          const t = (attrs as WikilinkAttributes).type;
          return t ? { "data-type": t } : {};
        },
      },
    };
  },

  parseHTML() {
    // Match any element carrying `data-wikilink` (the editor emits an <a>;
    // the read-only <Wikilink> emits <a>/<span>), at a priority above the
    // StarterKit Link mark's `a[href]` rule. Without the priority bump a
    // copied-and-pasted rendered wikilink — which is a real `<a href>` —
    // would be claimed by the link mark and degrade into a plain markdown
    // link that no longer navigates.
    return [{ tag: "[data-wikilink]", priority: 1000 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const text = (node.attrs as WikilinkAttributes).text;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        "data-wikilink": "",
        class: "tiptap-wikilink",
      }),
      text,
    ];
  },

  // Used when the editor is asked to render plain text (copy as text, etc.).
  renderText({ node }) {
    const { text, target } = node.attrs as WikilinkAttributes;
    return serializeWikilink(text ?? "", target ?? null);
  },

  // Typing literal `[[Foo]]` or `[[Target|Foo]]` becomes a wikilink atom on
  // the closing `]]`.
  addInputRules() {
    return [
      new InputRule({
        find: /\[\[([^[\]\n]+)\]\]$/,
        handler: ({ state, range, match, chain }) => {
          const { text, target } = parseWikilinkInner(match[1]);
          if (!text) return;
          const node = this.type.create({ text, target });
          chain()
            .deleteRange(range)
            .insertContentAt(range.from, [
              node.toJSON(),
              { type: "text", text: " " },
            ])
            .run();
          // Suppress the trailing `]` that triggered the rule.
          void state;
        },
      }),
    ];
  },

  // Pasting text containing `[[Foo]]` / `[[Target|Foo]]` (e.g. copy-from-
  // Obsidian) creates atoms.
  addPasteRules() {
    return [
      nodePasteRule({
        find: /\[\[([^[\]\n]+)\]\]/g,
        type: this.type,
        getAttributes: (match) => {
          const { text, target } = parseWikilinkInner(match[1]);
          return text ? { text, target } : false;
        },
      }),
    ];
  },

  addStorage() {
    const spec: MarkdownNodeSpec = {
      serialize(state: MarkdownSerializerState, node: PMNode) {
        const { text, target } = node.attrs as WikilinkAttributes;
        state.write(serializeWikilink(text ?? "", target ?? null));
      },
      parse: {
        setup(md: MarkdownIt) {
          // tiptap-markdown calls setup() on every parse; guard against
          // re-registering the rule (markdown-it doesn't dedupe by name).
          const installed = "__woodshedWikilinkInstalled" as const;
          const mdAny = md as unknown as Record<string, unknown>;
          if (mdAny[installed]) return;
          mdAny[installed] = true;

          // Run BEFORE the built-in `link` rule so `[[foo]]` isn't consumed
          // as `[` + ref-link. Inline rule signature comes from markdown-it
          // (their types are incomplete here, so we treat state loosely).
          md.inline.ruler.before(
            "link",
            "wikilink",
            (state: StateInline, silent: boolean) => {
              const start = state.pos;
              const max = state.posMax;
              if (start + 4 > max) return false;
              if (state.src.charCodeAt(start) !== 0x5b /* [ */) return false;
              if (state.src.charCodeAt(start + 1) !== 0x5b) return false;

              // Find closing `]]`. Bail on newlines or nested `[`/`]`.
              let end = -1;
              for (let i = start + 2; i < max - 1; i++) {
                const c = state.src.charCodeAt(i);
                if (c === 0x0a /* \n */) return false;
                if (c === 0x5b /* [ */) return false;
                if (c === 0x5d /* ] */) {
                  if (state.src.charCodeAt(i + 1) === 0x5d) {
                    end = i;
                    break;
                  }
                  return false;
                }
              }
              if (end === -1) return false;

              const text = state.src.slice(start + 2, end).trim();
              if (!text) return false;

              if (!silent) {
                const token = state.push("wikilink", "", 0);
                token.markup = "[[";
                token.content = text;
              }
              state.pos = end + 2;
              return true;
            },
          );

          md.renderer.rules.wikilink = (tokens, idx) => {
            const { text, target } = parseWikilinkInner(tokens[idx].content);
            const safeText = md.utils.escapeHtml(text);
            const targetAttr = target
              ? ` data-target="${md.utils.escapeHtml(target)}"`
              : "";
            return `<a data-wikilink data-text="${safeText}"${targetAttr}>${safeText}</a>`;
          };
        },
      },
    };
    return { markdown: spec };
  },
});
