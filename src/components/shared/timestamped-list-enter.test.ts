import { afterEach, describe, expect, it } from "vitest";
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { DailyTimestamp } from "./extensions/daily-timestamp";
import {
  handleTimestampedListEnter,
  insertParagraphAboveTrailingEmbed,
} from "./timestamped-list-enter";

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

  it("creates a distinct top-level block for every Enter on an empty block", () => {
    editor = new Editor({
      extensions: [StarterKit, DailyTimestamp],
      content: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "First block" }],
                  },
                ],
              },
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Second block" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    let firstTextEnd = -1;
    editor.state.doc.descendants((node, pos) => {
      if (firstTextEnd === -1 && node.isText && node.text === "First block") {
        firstTextEnd = pos + node.nodeSize;
        return false;
      }
      return true;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, firstTextEnd),
      ),
    );

    for (let index = 0; index < 3; index += 1) {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        cancelable: true,
      });
      expect(handleTimestampedListEnter(event, editor)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
    }

    expect(editor.state.doc.child(0).childCount).toBe(5);
  });

  it("treats a hidden daily timestamp as an empty line above the embed", () => {
    editor = new Editor({
      extensions: [StarterKit, DailyTimestamp, TestEmbed],
      content: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "dailyTimestamp", attrs: { time: "12:24" } },
                    ],
                  },
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
        TextSelection.create(editor.state.doc, paragraphPos + 2),
      ),
    );

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      cancelable: true,
    });
    expect(handleTimestampedListEnter(event, editor)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc.child(0).child(0).childCount).toBe(3);
  });
});
