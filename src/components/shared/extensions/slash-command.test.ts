import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { slashCommandItems } from "./slash-command";

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
    ],
    content,
  });
}

describe("slash command items", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("image command reports the trigger range without deleting it yet", () => {
    editor = makeEditor("/im");
    const item = slashCommandItems.find((command) => command.id === "image");
    let insertRange: { from: number; to: number } | null = null;

    editor.view.dom.addEventListener("tiptap-open-image-picker", (event) => {
      insertRange = (
        event as CustomEvent<{ range: { from: number; to: number } }>
      ).detail.range;
    });

    item?.command({ editor, range: { from: 1, to: 4 } });

    expect(item).toBeTruthy();
    expect(insertRange).toEqual({ from: 1, to: 4 });
    expect(editor.getText()).toBe("/im");
  });
});
