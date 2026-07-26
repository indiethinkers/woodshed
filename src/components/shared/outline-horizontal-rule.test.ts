import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Typography from "@tiptap/extension-typography";
import { TextSelection } from "@tiptap/pm/state";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { DailyTimestamp } from "./extensions/daily-timestamp";
import { OutlineListItem } from "./extensions/outline-fold";
import { insertTimestampedHorizontalRule } from "./timestamped-list-enter";

function typeText(editor: Editor, text: string) {
  for (const character of text) {
    if (character === "-" && insertTimestampedHorizontalRule(editor)) {
      continue;
    }
    const { from, to } = editor.state.selection;
    const defaultTransaction = () =>
      editor.state.tr.insertText(character, from, to).scrollIntoView();
    let handled = false;
    editor.view.someProp("handleTextInput", (handler) => {
      if (!handler(editor.view, from, to, character, defaultTransaction)) {
        return false;
      }
      handled = true;
      return true;
    });
    if (!handled) {
      editor.view.dispatch(defaultTransaction());
    }
  }
}

describe("outline horizontal-rule shortcut", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("turns three hyphens into a divider inside an outline", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    editor = new Editor({
      element,
      extensions: [
        StarterKit.configure({ listItem: false, trailingNode: false }),
        OutlineListItem,
        Typography,
        DailyTimestamp,
        Markdown.configure({ bulletListMarker: "-" }),
      ],
      content: "<ul><li><p></p></li></ul>",
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.near(editor.state.doc.resolve(3)),
      ),
    );

    typeText(editor, "---");

    let horizontalRules = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "horizontalRule") horizontalRules += 1;
    });
    expect(horizontalRules).toBe(1);
    expect(editor.getText()).not.toContain("—");
    expect(editor.getText()).not.toContain("---");
    const markdown = (
      editor.storage as unknown as { markdown: MarkdownStorage }
    ).markdown.getMarkdown();
    expect(markdown).toContain("---");
  });
});
