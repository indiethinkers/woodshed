import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import {
  Suggestion,
  type SuggestionMatch,
  type SuggestionOptions,
  type Trigger,
} from "@tiptap/suggestion";
import type { WikilinkType } from "./wikilink";

/// Result of a picker selection. Two shapes:
///   - `{ existing: { text } }`        — picked an existing page; insert
///                                        a wikilink with that label
///   - `{ create: { text, type } }`    — picked "Create new <type>"; the
///                                        picker eagerly fires the matching
///                                        `*_create` Tauri command, then
///                                        inserts a wikilink tagged with
///                                        that type
export type WikilinkPickerSelection =
  | { kind: "existing"; text: string }
  | { kind: "create"; text: string; type: WikilinkType };

export const WikilinkSuggestionPluginKey = new PluginKey("wikilink-suggestion");

export interface WikilinkSuggestionOptions {
  suggestion: Omit<SuggestionOptions<unknown, WikilinkPickerSelection>, "editor">;
}

/**
 * Suggestion extension that opens a page-picker when the user types `[[`
 * with an empty selection.
 *
 * `@tiptap/suggestion` uses a single trigger character; we set it to `[`
 * and override `findSuggestionMatch` to require a leading `[[` (the prior
 * character must also be `[`). Without this guard, every `[` would open the
 * picker, including legit cases like markdown links `[text](url)`.
 *
 * The selection-wrap path (user has text selected and types `[`) is NOT
 * handled here — by the time Suggestion observes a transaction, the
 * selection has already been replaced with `[`. That path lives in the
 * editor's `editorProps.handleKeyDown`.
 */
export const WikilinkSuggestion = Extension.create<WikilinkSuggestionOptions>({
  name: "wikilinkSuggestion",

  addOptions() {
    return {
      suggestion: {
        char: "[",
        allowSpaces: true,
        allowedPrefixes: null,
        startOfLine: false,
        pluginKey: WikilinkSuggestionPluginKey,
        // Items are produced inside the React picker component (which can
        // call `useSearch(query)` and other async hooks). We feed an empty
        // list to the Suggestion plugin and let the picker render its own.
        items: () => [],
        // Custom matcher: only fire when `[[` precedes the cursor and we
        // haven't yet seen the closing `]]`. Captures everything after `[[`
        // up to either end-of-line or `]]`.
        findSuggestionMatch: (config: Trigger): SuggestionMatch => {
          const { $position } = config;
          const parent = $position.parent;
          if (!parent) return null;
          const before = parent.textBetween(
            0,
            $position.parentOffset,
            null,
            "￼",
          );
          // The user already closed the brackets — bail so we don't reopen.
          if (before.endsWith("]]")) return null;

          const m = before.match(/\[\[([^[\]\n]*)$/);
          if (!m) return null;

          const matchLength = m[0].length;
          const queryText = m[1];
          return {
            range: {
              from: $position.pos - matchLength,
              to: $position.pos,
            },
            query: queryText,
            text: m[0],
          };
        },
        command: ({ editor, range, props }) => {
          const selection = props as WikilinkPickerSelection;
          const text = selection.text.trim();
          if (!text) return;

          const attrs: { text: string; type?: WikilinkType | null } = {
            text,
            type: selection.kind === "create" ? selection.type : null,
          };

          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContentAt(range.from, [
              { type: "wikilink", attrs },
              { type: "text", text: " " },
            ])
            .run();
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<unknown, WikilinkPickerSelection>({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
