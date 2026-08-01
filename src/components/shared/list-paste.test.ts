import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { Wikilink } from "./extensions/wikilink";
import {
  insertNormalizedPlainTextPaste,
  insertPlainTextParagraphsAsListItems,
  normalizeWrappedPlainText,
  plainTextParagraphBlocks,
} from "./list-paste";

function makeEditor(content = "") {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  const editor = new Editor({
    element: dom,
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: false,
        bulletListMarker: "-",
      }),
      Wikilink,
    ],
    content,
  });
  setCursorAtFirstTextblockEnd(editor);
  return editor;
}

function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
}

function setCursorAtFirstTextblockEnd(editor: Editor) {
  let target: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock || target !== null) return;
    target = pos + 1 + node.content.size;
    return false;
  });
  if (target !== null) editor.commands.setTextSelection(target);
}

describe("plainTextParagraphBlocks", () => {
  it("splits blank-line-separated prose into paste blocks", () => {
    expect(
      plainTextParagraphBlocks(
        "Ok here we go.\nProductivity for the sake of it.\n\nThe struggle.\n\nThe chase.",
      ),
    ).toEqual([
      "Ok here we go.\nProductivity for the sake of it.",
      "The struggle.",
      "The chase.",
    ]);
  });

  it("leaves single paragraphs for the default paste pipeline", () => {
    expect(plainTextParagraphBlocks("Only one paragraph.")).toEqual([]);
  });
});

describe("normalizeWrappedPlainText", () => {
  it("unwraps hard-wrapped prose inside paragraphs", () => {
    const input =
      "I want you to help me turn the email page into a triage app. Here's how it should work:\n\n" +
      "For every email that's in my inbox, I want it to create a card that shows me what the email is\n" +
      "about and then proposes a next action, whether that's a draft reply or any other thing that makes\n" +
      "sense.\n\n" +
      "It should allow me to scroll through my email and get through it just by talking to each card.";

    expect(normalizeWrappedPlainText(input)).toBe(
      "I want you to help me turn the email page into a triage app. Here's how it should work:\n\n" +
        "For every email that's in my inbox, I want it to create a card that shows me what the email is about and then proposes a next action, whether that's a draft reply or any other thing that makes sense.\n\n" +
        "It should allow me to scroll through my email and get through it just by talking to each card.",
    );
  });

  it("preserves lists and other structured markdown", () => {
    const input =
      "Inbox triage plan\n\n- summarize each message\n- propose a next action\n\n## Notes";

    expect(normalizeWrappedPlainText(input)).toBeNull();
  });

  it("leaves short line-by-line text alone", () => {
    expect(normalizeWrappedPlainText("Line one\nLine two\nLine three")).toBeNull();
    expect(normalizeWrappedPlainText("alpha\nbeta\ngamma")).toBeNull();
  });

  it("preserves intentional markdown hard breaks", () => {
    expect(
      normalizeWrappedPlainText(
        "First line keeps its hard break  \nSecond line should stay separate",
      ),
    ).toBeNull();
  });
});

describe("insertPlainTextParagraphsAsListItems", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("turns pasted paragraphs in an empty list item into sibling list items", () => {
    editor = makeEditor("- ");

    const handled = insertPlainTextParagraphsAsListItems(
      editor,
      "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
    );

    expect(handled).toBe(true);
    expect(getMarkdown(editor)).toBe(
      "- First paragraph.\n- Second paragraph.\n- Third paragraph.",
    );
  });

  it("preserves inline markdown and wikilinks in each pasted item", () => {
    editor = makeEditor("- ");

    const handled = insertPlainTextParagraphsAsListItems(
      editor,
      "First **bold** [[Alex Rivera]].\n\nSecond [link](https://example.com).",
    );

    expect(handled).toBe(true);
    const md = getMarkdown(editor);
    expect(md).toContain("- First **bold** [[Alex Rivera]].");
    expect(md).toContain("- Second [link](https://example.com).");
  });

  it("unwraps hard-wrapped paragraphs before inserting list items", () => {
    editor = makeEditor("- ");

    const handled = insertPlainTextParagraphsAsListItems(
      editor,
      "First paragraph starts here and keeps going long enough to look wrapped\nacross the next copied line.\n\nSecond paragraph.",
    );

    expect(handled).toBe(true);
    expect(getMarkdown(editor)).toBe(
      "- First paragraph starts here and keeps going long enough to look wrapped across the next copied line.\n- Second paragraph.",
    );
  });

  it("does not handle multi-paragraph paste outside a list item", () => {
    editor = makeEditor("");

    const handled = insertPlainTextParagraphsAsListItems(
      editor,
      "First.\n\nSecond.",
    );

    expect(handled).toBe(false);
    expect(getMarkdown(editor)).toBe("");
  });
});

describe("insertNormalizedPlainTextPaste", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("inserts unwrapped paragraphs outside lists", () => {
    editor = makeEditor("");

    const handled = insertNormalizedPlainTextPaste(
      editor,
      "For every email that's in my inbox, I want it to create a card that shows me what the email is\nabout and then proposes a next action.\n\nIt should track every single step in the process.",
    );

    expect(handled).toBe(true);
    expect(getMarkdown(editor)).toBe(
      "For every email that's in my inbox, I want it to create a card that shows me what the email is about and then proposes a next action.\n\nIt should track every single step in the process.",
    );
  });
});
