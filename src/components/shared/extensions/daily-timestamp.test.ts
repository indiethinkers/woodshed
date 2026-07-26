import { afterEach, describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { DailyTimestamp } from "./daily-timestamp";
import { Wikilink } from "./wikilink";
import {
  listItemHasVisibleContent,
  nestTimestampedListMarker,
} from "../timestamped-list-enter";

function makeEditor(content = "") {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  return new Editor({
    element: dom,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      DailyTimestamp,
      Wikilink,
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

describe("DailyTimestamp extension", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("parses a leading timestamp into an inline atom", () => {
    editor = makeEditor("- [16:04] First note");

    const json = editor.getJSON() as JSONContent;
    const item = json.content?.[0]?.content?.[0];
    const paragraph = item?.content?.[0];
    const timestamp = paragraph?.content?.[0] as
      | { type?: string; attrs?: { time?: string } }
      | undefined;

    expect(timestamp?.type).toBe("dailyTimestamp");
    expect(timestamp?.attrs?.time).toBe("16:04");
  });

  it("serializes timestamps back to readable markdown", () => {
    editor = makeEditor("- [16:04] First note");

    expect(getMarkdown(editor)).toBe("- [16:04] First note");
  });

  it("keeps timestamps in markdown while hiding them from the editor UI", () => {
    editor = makeEditor("- [16:04] First note");

    const timestamp = editor.view.dom.querySelector<HTMLElement>(
      "[data-daily-timestamp]",
    );

    expect(timestamp?.hidden).toBe(true);
    expect(timestamp?.getAttribute("data-time")).toBe("16:04");
    expect(getMarkdown(editor)).toBe("- [16:04] First note");
  });

  it("does not consume non-leading bracketed times", () => {
    editor = makeEditor("- Meet at [16:04]");

    const json = editor.getJSON() as JSONContent;
    const item = json.content?.[0]?.content?.[0];
    const paragraph = item?.content?.[0];
    const timestamp = paragraph?.content?.find(
      (node) => node.type === "dailyTimestamp",
    );

    expect(timestamp).toBeUndefined();
  });

  it("stamps a newly created empty list item on Enter (split)", () => {
    editor = makeEditor("- First note");

    editor.commands.focus("end");
    editor.commands.splitListItem("listItem");

    expect(getMarkdown(editor)).toMatch(
      /^- First note\n\s*- \[\d{2}:\d{2}\]/,
    );
  });

  it("does not stamp pre-existing empty list items on load", () => {
    editor = makeEditor("- \n- \n");

    // Mounting alone should not backfill timestamps onto the empty rows.
    expect(getMarkdown(editor)).not.toMatch(/\[\d{2}:\d{2}\]/);
  });

  it("stamps an empty list item when it receives text", () => {
    editor = makeEditor("- ");

    editor.commands.focus("end");
    editor.commands.insertContent("Captured thought");

    expect(getMarkdown(editor)).toMatch(/^- \[\d{2}:\d{2}\] Captured thought$/);
  });

  it("does not backfill an existing text list item during edits", () => {
    editor = makeEditor("- Existing thought");

    editor.commands.focus("end");
    editor.commands.insertContent(" updated");

    expect(getMarkdown(editor)).not.toMatch(/^- \[\d{2}:\d{2}\]/);
  });

  it("recognizes a markdown list marker typed after a daily timestamp", () => {
    editor = makeEditor("- [16:04] Parent\n- [16:05] -");
    editor.commands.focus("end");

    expect(nestTimestampedListMarker(editor)).toBe(true);

    expect(getMarkdown(editor)).toBe("- [16:04] Parent\n  - ");
  });

  it("drops the timestamp when a row is nested under another (Tab/indent)", () => {
    editor = makeEditor("- [16:04] First note\n- [16:05] Second note");

    // Put the caret in the second top-level row and indent it so it becomes a
    // child of the first. Nested rows never carry a timestamp, so its stamp
    // should be stripped while the top-level row keeps its own.
    editor.commands.focus("end");
    editor.commands.sinkListItem("listItem");

    const md = getMarkdown(editor);
    expect(md).toContain("[16:04]");
    expect(md).not.toContain("[16:05]");
  });

  it("treats timestamp plus wikilink rows as non-empty for Enter handling", () => {
    editor = makeEditor("- [21:03] [[Deep work in the age of AI]]");

    const listItem = editor.state.doc.child(0).child(0);

    expect(listItemHasVisibleContent(listItem)).toBe(true);
  });

  it("treats timestamp-only rows as empty for Enter handling", () => {
    editor = makeEditor("- [21:03] ");

    const listItem = editor.state.doc.child(0).child(0);

    expect(listItemHasVisibleContent(listItem)).toBe(false);
  });
});
