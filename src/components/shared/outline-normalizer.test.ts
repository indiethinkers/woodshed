import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { Wikilink } from "./extensions/wikilink";
import {
  normalizeToOutline,
  removeGeneratedTrailingEmptyBullet,
} from "./outline-normalizer";

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
      Wikilink,
    ],
    content,
  });
}

function topLevelTypes(editor: Editor): string[] {
  const types: string[] = [];
  editor.state.doc.forEach((c) => types.push(c.type.name));
  return types;
}

function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
}

describe("normalizeToOutline", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("wraps a single paragraph into a bulletList", () => {
    editor = makeEditor("Just a paragraph.");
    expect(topLevelTypes(editor)).toEqual(["paragraph"]);
    normalizeToOutline(editor);
    expect(topLevelTypes(editor)).toEqual(["bulletList"]);
    const md = getMarkdown(editor);
    expect(md).toContain("- Just a paragraph");
  });

  it("collapses multiple consecutive paragraphs into one bulletList", () => {
    editor = makeEditor("First.\n\nSecond.\n\nThird.");
    expect(topLevelTypes(editor)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    normalizeToOutline(editor);
    // Three loose paragraphs become ONE bulletList with three items, not
    // three separate bulletLists.
    expect(topLevelTypes(editor)).toEqual(["bulletList"]);
    expect(editor.state.doc.firstChild?.childCount).toBe(3);
  });

  it("is a no-op on a doc that's already a clean outline", () => {
    editor = makeEditor("- one\n- two\n- three");
    expect(topLevelTypes(editor)).toEqual(["bulletList"]);
    const before = editor.getHTML();
    normalizeToOutline(editor);
    expect(editor.getHTML()).toBe(before);
  });

  it("does not append an empty row to a non-empty outline", () => {
    editor = makeEditor("- one");
    normalizeToOutline(editor);
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
  });

  it("preserves headings as listItem content", () => {
    editor = makeEditor("# Big heading\n\nFollow-up paragraph.");
    normalizeToOutline(editor);
    expect(topLevelTypes(editor)).toEqual(["bulletList"]);
    // The heading still exists in the doc — just wrapped inside a listItem.
    let foundHeading = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "heading") foundHeading = true;
    });
    expect(foundHeading).toBe(true);
  });

  it("preserves wikilinks during the normalization pass", () => {
    editor = makeEditor("Hello [[Alex Rivera]] world.");
    normalizeToOutline(editor);
    let foundWikilink = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "wikilink") foundWikilink = true;
    });
    expect(foundWikilink).toBe(true);
  });

  it("interleaves existing lists between paragraph runs", () => {
    editor = makeEditor("Top intro.\n\n- existing\n- list\n\nFollow-up.");
    expect(topLevelTypes(editor)).toEqual([
      "paragraph",
      "bulletList",
      "paragraph",
    ]);
    normalizeToOutline(editor);
    // Paragraph runs and existing lists collapse into one compact outline.
    expect(topLevelTypes(editor)).toEqual(["bulletList"]);
    expect(editor.state.doc.firstChild?.childCount).toBe(4);
  });

  it("replaces an empty doc with a single empty bullet", () => {
    editor = makeEditor("");
    normalizeToOutline(editor);
    expect(topLevelTypes(editor)).toEqual(["bulletList"]);
    const list = editor.state.doc.firstChild!;
    expect(list.childCount).toBe(1);
  });
});

describe("removeGeneratedTrailingEmptyBullet", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("removes a legacy empty tail after an existing row", () => {
    editor = makeEditor("- [08:32]\n-");
    removeGeneratedTrailingEmptyBullet(editor);
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
  });

  it("keeps the sole empty row on a blank day", () => {
    editor = makeEditor("");
    normalizeToOutline(editor);
    removeGeneratedTrailingEmptyBullet(editor);
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
  });
});
