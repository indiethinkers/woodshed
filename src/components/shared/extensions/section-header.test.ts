import { describe, it, expect, afterEach } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { SectionHeader } from "./section-header";
import { slashCommandItems } from "./slash-command";

function makeEditor(content = "") {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  return new Editor({
    element: dom,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3, 4, 5] },
      }),
      SectionHeader,
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

describe("SectionHeader extension", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("parses markdown h6 as a section header node", () => {
    editor = makeEditor("###### Notes");

    const node = (editor.getJSON() as JSONContent).content?.[0];
    expect(node?.type).toBe("sectionHeader");
    expect(node?.content?.[0]?.text).toBe("Notes");
  });

  it("serializes section headers back to markdown h6", () => {
    editor = makeEditor("###### Notes");

    expect(getMarkdown(editor)).toBe("###### Notes");
  });

  it("can turn the current textblock into a section header", () => {
    editor = makeEditor("Notes");

    expect(editor.commands.setNode("sectionHeader")).toBe(true);

    const node = editor.getJSON().content?.[0];
    expect(node?.type).toBe("sectionHeader");
    expect(getMarkdown(editor)).toBe("###### Notes");
  });

  it("slash command can lift an outline bullet into a section header", () => {
    editor = makeEditor("- /section");
    const item = slashCommandItems.find((command) => command.id === "section-header");

    item?.command({ editor, range: { from: 3, to: 11 } });

    const node = editor.getJSON().content?.[0];
    expect(item).toBeTruthy();
    expect(node?.type).toBe("sectionHeader");
    expect(editor.state.selection.$from.parent.type.name).toBe(
      "sectionHeader",
    );
    expect(getMarkdown(editor)).toBe("###### ");
  });
});
