import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { Wikilink } from "./wikilink";

function makeEditor(content = "") {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  return new Editor({
    element: dom,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
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

function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
}

describe("Wikilink markdown round-trip", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("parses [[foo]] from markdown into a wikilink node", () => {
    editor = makeEditor("Hello [[Alex Rivera]] world.");
    const json = editor.getJSON();
    const para = json.content?.[0];
    expect(para?.type).toBe("paragraph");
    const wl = para?.content?.find((n) => n.type === "wikilink") as
      | { type: string; attrs?: { text?: string } }
      | undefined;
    expect(wl).toBeTruthy();
    expect(wl?.attrs?.text).toBe("Alex Rivera");
  });

  it("serializes a wikilink node back to [[text]]", () => {
    editor = makeEditor("Hello [[Alex Rivera]] world.");
    const md = getMarkdown(editor);
    expect(md).toContain("[[Alex Rivera]]");
    // No trailing or extra brackets
    expect(md).not.toContain("[[[");
    expect(md).not.toContain("]]]");
  });

  it("round-trips multiple wikilinks in a single paragraph", () => {
    const original = "Lunch with [[Alex Rivera]] and [[Sam Lee]] today.";
    editor = makeEditor(original);
    const md = getMarkdown(editor);
    expect(md).toContain("[[Alex Rivera]]");
    expect(md).toContain("[[Sam Lee]]");
  });

  it("does not consume single-bracket [text](url) markdown links", () => {
    editor = makeEditor("See [docs](https://example.com) for details.");
    const md = getMarkdown(editor);
    // The link should round-trip through the standard markdown link rule.
    expect(md).toContain("[docs](https://example.com)");
    expect(md).not.toContain("[[");
  });

  it("ignores [[ without closing ]]", () => {
    editor = makeEditor("This has an open [[bracket but no close.");
    const json = editor.getJSON();
    const para = json.content?.[0];
    const wl = para?.content?.find((n) => n.type === "wikilink") as
      | { type: string; attrs?: { text?: string } }
      | undefined;
    expect(wl).toBeFalsy();
  });

  it("ignores empty [[]]", () => {
    editor = makeEditor("Empty [[]] brackets.");
    const json = editor.getJSON();
    const para = json.content?.[0];
    const wl = para?.content?.find((n) => n.type === "wikilink") as
      | { type: string; attrs?: { text?: string } }
      | undefined;
    expect(wl).toBeFalsy();
  });

  it("trims whitespace inside [[ foo ]]", () => {
    editor = makeEditor("Padded [[  Alex Rivera  ]] link.");
    const json = editor.getJSON();
    const para = json.content?.[0];
    const wl = para?.content?.find((n) => n.type === "wikilink") as
      | { type: string; attrs?: { text?: string } }
      | undefined;
    expect(wl?.attrs?.text).toBe("Alex Rivera");
  });

  it("preserves wikilinks across nested list items", () => {
    const original = "- parent with [[Alex Rivera]]\n  - child with [[Sam Lee]]";
    editor = makeEditor(original);
    const md = getMarkdown(editor);
    expect(md).toContain("[[Alex Rivera]]");
    expect(md).toContain("[[Sam Lee]]");
  });
});
