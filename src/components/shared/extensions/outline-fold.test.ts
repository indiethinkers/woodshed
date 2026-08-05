import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { OutlineListItem, parseCollapsedMarkers } from "./outline-fold";
import { DailyTimestamp } from "./daily-timestamp";
import { ImageMd } from "./image-md";
import {
  deleteEmptyListItem,
  deleteListItemTextBeforeCursor,
  insertTopLevelItemAfterChildren,
  outdentEmptyNestedListItem,
  outdentListItemAtStart,
} from "../timestamped-list-enter";
import { insertPlainTextParagraphsAsListItems } from "../list-paste";

function makeEditor(content = "") {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  return new Editor({
    element: dom,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        listItem: false,
        trailingNode: false,
      }),
      OutlineListItem,
      DailyTimestamp,
      // The listItem content expression references `image` (a bare image
      // row is a valid list item); the app schema always registers this.
      ImageMd,
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

function setCursorAtParagraphEnd(editor: Editor, text: string) {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === text) {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  if (end < 0) throw new Error(`Paragraph not found: ${text}`);
  editor.commands.setTextSelection(end);
}

function setCursorAtParagraphStart(editor: Editor, text: string) {
  let start = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === text) {
      start = pos + 1;
      return false;
    }
    return true;
  });
  if (start < 0) throw new Error(`Paragraph not found: ${text}`);
  editor.commands.setTextSelection(start);
}

function setSelectionFromParagraphStartToEnd(
  editor: Editor,
  startText: string,
  endText: string,
) {
  let from = -1;
  let to = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === startText) {
      from = pos + 1;
    }
    if (node.type.name === "paragraph" && node.textContent === endText) {
      to = pos + node.nodeSize - 1;
    }
    return true;
  });
  if (from < 0) throw new Error(`Start paragraph not found: ${startText}`);
  if (to < 0) throw new Error(`End paragraph not found: ${endText}`);
  editor.commands.setTextSelection({ from, to });
}

function setCursorAtEmptyParagraph(editor: Editor, nested: boolean) {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph" || node.content.size !== 0) {
      return true;
    }
    const depth = editor.state.doc.resolve(pos).depth;
    if ((nested && depth > 3) || (!nested && depth <= 3)) {
      target = pos + 1;
      return false;
    }
    return true;
  });
  if (target < 0) throw new Error("Empty paragraph not found");
  editor.commands.setTextSelection(target);
}

/** First top-level list item: doc > bulletList > listItem. */
function firstItem(editor: Editor) {
  return editor.state.doc.child(0).child(0);
}

/** Document position just before the first top-level list item. */
function firstItemPos(): number {
  // doc open (0) → bulletList open (1) → listItem starts at 1.
  return 1;
}

describe("OutlineListItem collapse round-trip", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("lifts a trailing collapse marker into the attribute and strips it", () => {
    editor = makeEditor("- Parent <!-- collapsed -->\n\n  - Child");
    parseCollapsedMarkers(editor);

    const item = firstItem(editor);
    expect(item.attrs.collapsed).toBe(true);
    expect(item.firstChild?.textContent).toBe("Parent");
  });

  it("serializes a collapsed parent back to the trailing marker", () => {
    editor = makeEditor("- Parent\n\n  - Child");
    editor.view.dispatch(
      editor.state.tr.setNodeAttribute(firstItemPos(), "collapsed", true),
    );

    expect(getMarkdown(editor)).toMatch(/^- Parent <!-- collapsed -->/);
  });

  it("round-trips a collapsed bullet without drift", () => {
    editor = makeEditor("- Parent <!-- collapsed -->\n\n  - Child");
    parseCollapsedMarkers(editor);
    const once = getMarkdown(editor);

    // Re-ingest the serialized form and confirm it's a fixed point.
    const second = makeEditor(once);
    parseCollapsedMarkers(second);
    expect(getMarkdown(second)).toBe(once);
    second.destroy();
  });

  it("emits no marker for an expanded parent", () => {
    editor = makeEditor("- Parent\n\n  - Child");
    expect(getMarkdown(editor)).not.toMatch(/collapsed/);
  });

  it("does not emit a marker for a collapsed item with no children", () => {
    editor = makeEditor("- Lonely thought");
    editor.view.dispatch(
      editor.state.tr.setNodeAttribute(firstItemPos(), "collapsed", true),
    );

    expect(getMarkdown(editor)).not.toMatch(/collapsed/);
  });

  it("keeps a top-level timestamp alongside the collapse marker", () => {
    editor = makeEditor("- [09:30] Parent <!-- collapsed -->\n\n  - Child");
    parseCollapsedMarkers(editor);

    expect(getMarkdown(editor)).toMatch(/^- \[09:30\] Parent <!-- collapsed -->/);
  });

  it("toggles a parent when its fold dash is pressed", () => {
    editor = makeEditor("- Parent\n\n  - Child");
    const toggle = editor.view.dom.querySelector<HTMLButtonElement>(
      ".outline-fold-toggle",
    );

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    toggle?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );

    expect(firstItem(editor).attrs.collapsed).toBe(true);
    expect(
      editor.view.dom
        .querySelector(".outline-fold-toggle")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("inserts a top-level row after a collapsed parent's children", () => {
    editor = makeEditor("- [09:30] Parent <!-- collapsed -->\n\n  - Child");
    parseCollapsedMarkers(editor);

    setCursorAtParagraphEnd(editor, "Parent");

    expect(insertTopLevelItemAfterChildren(editor)).toBe(true);

    const list = editor.state.doc.firstChild;
    expect(list?.childCount).toBe(2);
    expect(list?.child(0).attrs.collapsed).toBe(true);
    expect(list?.child(0).lastChild?.type.name).toBe("bulletList");
    expect(list?.child(1).childCount).toBe(1);
    expect(getMarkdown(editor)).toMatch(
      /^- \[09:30\] Parent <!-- collapsed -->[\s\S]*  - Child[\s\S]*^-[ \t]*$/m,
    );
  });

  it("does not lift a top-level outline row out of the list on Shift+Tab", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - Child");
    setCursorAtParagraphEnd(editor, "Parent");

    expect(insertTopLevelItemAfterChildren(editor)).toBe(true);
    const before = getMarkdown(editor);
    expect(editor.commands.keyboardShortcut("Shift-Tab")).toBe(true);

    expect(getMarkdown(editor)).toBe(before);
    const list = editor.state.doc.firstChild;
    expect(list?.type.name).toBe("bulletList");
    expect(list?.childCount).toBe(2);
    expect(list?.child(1).type.name).toBe("listItem");
  });

  it("still outdents an empty nested row on Shift+Tab", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - Child");
    setCursorAtParagraphEnd(editor, "Child");

    expect(editor.commands.splitListItem("listItem")).toBe(true);
    expect(editor.commands.keyboardShortcut("Shift-Tab")).toBe(true);

    const list = editor.state.doc.firstChild;
    expect(list?.type.name).toBe("bulletList");
    expect(list?.childCount).toBe(2);
    expect(list?.child(0).lastChild?.type.name).toBe("bulletList");
    expect(list?.child(1).type.name).toBe("listItem");
    expect(getMarkdown(editor)).toMatch(
      /^- \[09:30\] Parent[\s\S]*^  - Child[\s\S]*^-[ \t]*$/m,
    );
  });

  it("outdents an empty nested row on Enter instead of swallowing the key", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - Child");
    setCursorAtParagraphEnd(editor, "Child");

    expect(editor.commands.splitListItem("listItem")).toBe(true);
    expect(outdentEmptyNestedListItem(editor)).toBe(true);

    const list = editor.state.doc.firstChild;
    expect(list?.type.name).toBe("bulletList");
    expect(list?.childCount).toBe(2);
    expect(getMarkdown(editor)).toMatch(
      /^- \[09:30\] Parent[\s\S]*^  - Child[\s\S]*^-[ \t]*$/m,
    );
  });

  it("indents a top-level row under the previous row on Tab", () => {
    editor = makeEditor("- [09:30] Parent\n- [09:31] Child");
    setCursorAtParagraphEnd(editor, "Child");

    expect(editor.commands.keyboardShortcut("Tab")).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] Parent\n  - Child");
  });

  it("keeps Tab inside the editor when the first row cannot indent", () => {
    editor = makeEditor("- [09:30] Parent");
    setCursorAtParagraphEnd(editor, "Parent");

    expect(editor.commands.keyboardShortcut("Tab")).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] Parent");
  });

  it("indents a selected block of sibling rows together on Tab", () => {
    editor = makeEditor("- [09:30] A\n- [09:31] B\n- [09:32] C");
    setSelectionFromParagraphStartToEnd(editor, "B", "C");

    expect(editor.commands.keyboardShortcut("Tab")).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] A\n  - B\n  - C");
  });

  it("outdents a non-empty nested row without losing text on Shift+Tab", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - Child");
    setCursorAtParagraphEnd(editor, "Child");

    expect(editor.commands.keyboardShortcut("Shift-Tab")).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] Parent\n- Child");
  });

  it("outdents a selected block of nested sibling rows together on Shift+Tab", () => {
    editor = makeEditor("- [09:30] A\n\n  - B\n  - C");
    setSelectionFromParagraphStartToEnd(editor, "B", "C");

    expect(editor.commands.keyboardShortcut("Shift-Tab")).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] A\n- B\n- C");
  });

  it("outdents a nested row on Backspace at the start of its text", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - Child");

    let start = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && node.textContent === "Child") {
        start = pos + 1;
        return false;
      }
      return true;
    });
    editor.commands.setTextSelection(start);

    expect(outdentListItemAtStart(editor)).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] Parent\n- Child");
  });

  it("removes an empty nested row on Backspace after command-delete clears its text", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - Child");

    let from = -1;
    let to = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && node.textContent === "Child") {
        from = pos + 1;
        to = from + node.content.size;
        return false;
      }
      return true;
    });
    editor.chain().setTextSelection({ from, to }).deleteSelection().run();

    expect(getMarkdown(editor)).toBe("- [09:30] Parent\n  - ");
    expect(deleteEmptyListItem(editor)).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] Parent");
    expect(editor.state.selection.$from.parent.textContent).toBe("Parent");
  });

  it("removes an empty parent row while preserving its children", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - Child");

    let from = -1;
    let to = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && node.textContent === "Parent") {
        const firstInline = node.firstChild;
        const offset = firstInline?.type.name === "dailyTimestamp"
          ? firstInline.nodeSize
          : 0;
        from = pos + 1 + offset;
        to = pos + node.nodeSize - 1;
        return false;
      }
      return true;
    });
    editor.chain().setTextSelection({ from, to }).deleteSelection().run();

    expect(getMarkdown(editor)).toBe("- [09:30] \n  - Child");
    expect(deleteEmptyListItem(editor)).toBe(true);
    expect(getMarkdown(editor)).toBe("- Child");
  });

  it("removes an empty nested parent row while preserving its children", () => {
    editor = makeEditor("- [09:30] Top\n\n  - Parent\n\n    - Grandchild");

    let from = -1;
    let to = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && node.textContent === "Parent") {
        from = pos + 1;
        to = pos + node.nodeSize - 1;
        return false;
      }
      return true;
    });
    editor.chain().setTextSelection({ from, to }).deleteSelection().run();

    expect(deleteEmptyListItem(editor)).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] Top\n  - Grandchild");
  });

  it("clears only the current list item text on command-delete", () => {
    editor = makeEditor(
      "- [09:30] This is another test\n\n  - a nested line with multiple words",
    );
    setCursorAtParagraphEnd(editor, "a nested line with multiple words");

    expect(deleteListItemTextBeforeCursor(editor)).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] This is another test\n  - ");
    expect(editor.state.selection.$from.parent.textContent).toBe("");
  });

  it("does not cross into the parent when command-delete starts a non-empty nested row", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - Child");
    setCursorAtParagraphStart(editor, "Child");

    expect(deleteListItemTextBeforeCursor(editor)).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] Parent\n\n  - Child");
  });

  it("lets command-delete remove an already-empty nested row", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - ");
    setCursorAtEmptyParagraph(editor, true);

    expect(deleteListItemTextBeforeCursor(editor)).toBe(false);
    expect(deleteEmptyListItem(editor)).toBe(true);
    expect(getMarkdown(editor)).toBe("- [09:30] Parent");
  });

  it("keeps the sole empty outline row so a blank day remains editable", () => {
    editor = makeEditor("- ");
    editor.commands.setTextSelection(2);

    expect(deleteEmptyListItem(editor)).toBe(false);
    expect(getMarkdown(editor)).toBe("- ");
  });

  it("normalizes back to an outline after deleting a full selection", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - Child");

    editor.commands.selectAll();
    expect(editor.commands.deleteSelection()).toBe(true);
    expect(getMarkdown(editor)).toBe("- ");
  });

  it("pastes multiple paragraphs into timestamped top-level rows", () => {
    editor = makeEditor("- ");
    setCursorAtEmptyParagraph(editor, false);

    expect(
      insertPlainTextParagraphsAsListItems(
        editor,
        "First pasted thought.\n\nSecond pasted thought.",
      ),
    ).toBe(true);

    expect(getMarkdown(editor)).toMatch(
      /^- \[\d{2}:\d{2}\] First pasted thought\.\n- \[\d{2}:\d{2}\] Second pasted thought\.$/,
    );
  });

  it("pastes multiple paragraphs into nested rows without timestamps", () => {
    editor = makeEditor("- [09:30] Parent\n\n  - ");
    setCursorAtEmptyParagraph(editor, true);

    expect(
      insertPlainTextParagraphsAsListItems(
        editor,
        "First nested thought.\n\nSecond nested thought.",
      ),
    ).toBe(true);

    expect(getMarkdown(editor)).toBe(
      "- [09:30] Parent\n  - First nested thought.\n  - Second nested thought.",
    );
  });

  it("does not stamp a nested list item that receives text", () => {
    editor = makeEditor("- Parent\n\n  - Child");
    // Locate the nested child's paragraph, empty it, then type — Case B
    // would stamp a top-level row but must skip this nested one.
    let nestedParaPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && node.textContent === "Child") {
        nestedParaPos = pos;
      }
      return true;
    });
    const from = nestedParaPos + 1;
    editor
      .chain()
      .setTextSelection({ from, to: from + "Child".length })
      .deleteSelection()
      .run();
    editor.commands.insertContent("Z");

    expect(getMarkdown(editor)).not.toMatch(/\[\d{2}:\d{2}\]/);
  });
});
