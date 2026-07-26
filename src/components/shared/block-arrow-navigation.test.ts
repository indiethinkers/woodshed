import { afterEach, describe, expect, it } from "vitest";
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { handleBlockArrowNavigation } from "./block-arrow-navigation";

const TestBlock = Node.create({
  name: "testBlock",
  group: "block",
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: "div[data-test-block]" }];
  },

  renderHTML() {
    return ["div", { "data-test-block": "" }];
  },
});

function makeEditor(content: Record<string, unknown>) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [StarterKit.configure({ codeBlock: false }), TestBlock],
    content,
  });
}

function textblockPos(editor: Editor, text: string, side: "start" | "end") {
  let target: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock || node.textContent !== text || target !== null) {
      return;
    }
    target = side === "start" ? pos + 1 : pos + 1 + node.content.size;
    return false;
  });
  if (target === null) throw new Error(`Textblock not found: ${text}`);
  return target;
}

function nodePos(editor: Editor, nodeName: string) {
  let target: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== nodeName || target !== null) return;
    target = pos;
    return false;
  });
  if (target === null) throw new Error(`Node not found: ${nodeName}`);
  return target;
}

function emptyTextblockStart(editor: Editor) {
  let target: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock || node.content.size !== 0 || target !== null) {
      return;
    }
    target = pos + 1;
    return false;
  });
  if (target === null) throw new Error("Empty textblock not found");
  return target;
}

function arrow(key: "ArrowUp" | "ArrowDown") {
  return new KeyboardEvent("keydown", { key, cancelable: true });
}

describe("handleBlockArrowNavigation", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.replaceChildren();
  });

  it("selects the atom block above a textblock instead of skipping it", () => {
    editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before" }] },
        { type: "testBlock" },
        { type: "paragraph", content: [{ type: "text", text: "After" }] },
      ],
    });
    editor.commands.setTextSelection(textblockPos(editor, "After", "start"));

    const event = arrow("ArrowUp");
    const handled = handleBlockArrowNavigation(editor.view, event);

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(nodePos(editor, "testBlock"));
  });

  it("selects the atom block below a textblock instead of skipping it", () => {
    editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before" }] },
        { type: "testBlock" },
        { type: "paragraph", content: [{ type: "text", text: "After" }] },
      ],
    });
    editor.commands.setTextSelection(textblockPos(editor, "Before", "end"));

    const handled = handleBlockArrowNavigation(editor.view, arrow("ArrowDown"));

    expect(handled).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(nodePos(editor, "testBlock"));
  });

  it("moves into an empty paragraph above instead of skipping it", () => {
    editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "After" }] },
      ],
    });
    editor.commands.setTextSelection(textblockPos(editor, "After", "start"));

    const handled = handleBlockArrowNavigation(editor.view, arrow("ArrowUp"));

    expect(handled).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.from).toBe(emptyTextblockStart(editor));
  });
});
