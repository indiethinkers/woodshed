import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { handleListIndentShortcut } from "./list-indent-shortcut";

function makeEditor(content = "") {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  return new Editor({
    element: dom,
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: false,
        bulletListMarker: "-",
      }),
    ],
    content,
  });
}

function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
}

function setCursorAfterText(editor: Editor, text: string) {
  let cursor: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || cursor !== null) return true;
    const index = node.text?.indexOf(text) ?? -1;
    if (index === -1) return true;
    cursor = pos + index + text.length;
    return false;
  });
  if (cursor === null) throw new Error(`Text not found: ${text}`);
  editor.commands.setTextSelection(cursor);
}

describe("handleListIndentShortcut", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("prevents Tab in a list item without changing the document", () => {
    editor = makeEditor("- parent\n- child");
    setCursorAfterText(editor, "child");
    const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });

    const before = getMarkdown(editor);
    expect(handleListIndentShortcut(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(getMarkdown(editor)).toBe(before);
  });

  it("prevents Shift+Tab in a list item without changing the document", () => {
    editor = makeEditor("- parent\n  - child");
    setCursorAfterText(editor, "child");
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      cancelable: true,
    });

    const before = getMarkdown(editor);
    expect(handleListIndentShortcut(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(getMarkdown(editor)).toBe(before);
  });

  it("prevents Tab outside list items without changing the document", () => {
    editor = makeEditor("parent\n\nchild");
    setCursorAfterText(editor, "child");
    const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });

    const before = getMarkdown(editor);
    expect(handleListIndentShortcut(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(getMarkdown(editor)).toBe(before);
  });
});
