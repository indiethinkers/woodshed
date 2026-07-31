import { afterEach, describe, expect, it } from "vitest";
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { insertParagraphAboveTrailingEmbed } from "./timestamped-list-enter";

const TestEmbed = Node.create({
  name: "testEmbed",
  group: "block",
  atom: true,
  parseHTML: () => [{ tag: "div[data-test-embed]" }],
  renderHTML: () => ["div", { "data-test-embed": "" }],
});

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("insertParagraphAboveTrailingEmbed", () => {
  it("creates another editable paragraph without moving the embed", () => {
    editor = new Editor({
      extensions: [StarterKit, TestEmbed],
      content: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph" },
                  { type: "testEmbed" },
                ],
              },
            ],
          },
        ],
      },
    });
    let paragraphPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (paragraphPos === -1 && node.type.name === "paragraph") {
        paragraphPos = pos;
        return false;
      }
      return true;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, paragraphPos + 1),
      ),
    );

    expect(insertParagraphAboveTrailingEmbed(editor)).toBe(true);

    const item = editor.state.doc.child(0).child(0);
    expect(item.childCount).toBe(3);
    expect(item.child(0).type.name).toBe("paragraph");
    expect(item.child(1).type.name).toBe("paragraph");
    expect(item.child(2).type.name).toBe("testEmbed");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });
});
