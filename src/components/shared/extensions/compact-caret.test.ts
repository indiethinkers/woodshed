import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { CompactCaret } from "./compact-caret";

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

function makeEditor(content = "") {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  return new Editor({
    element: dom,
    extensions: [StarterKit.configure({ codeBlock: false }), CompactCaret],
    content,
  });
}

function focusEditor(editor: Editor) {
  editor.view.dom.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
}

describe("CompactCaret extension", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    const mount = editor?.view.dom.parentElement;
    editor?.destroy();
    mount?.remove();
    editor = null;
  });

  it("does not insert a widget inside populated text", async () => {
    editor = makeEditor("<p>facility</p>");
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      top: 2,
      bottom: 30,
      left: 2,
      right: 2,
    });
    editor.commands.setTextSelection(1 + "facilit".length);
    focusEditor(editor);
    await nextFrame();

    expect(editor.view.dom.querySelector(".tiptap-compact-caret")).toBeNull();
    expect(
      editor.view.dom.parentElement?.querySelector(".tiptap-compact-caret"),
    ).toBeTruthy();
    expect(editor.view.dom.classList.contains("tiptap-compact-caret-active")).toBe(
      true,
    );
  });

  it("keeps the compact caret for empty text blocks", async () => {
    editor = makeEditor("");
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      top: 2,
      bottom: 30,
      left: 2,
      right: 2,
    });
    focusEditor(editor);
    await nextFrame();

    expect(
      editor.view.dom.parentElement?.querySelector(".tiptap-compact-caret"),
    ).toBeTruthy();
    expect(editor.view.dom.classList.contains("tiptap-compact-caret-active")).toBe(
      true,
    );
  });

  it("matches the editor font size instead of the line box", async () => {
    editor = makeEditor("<p>facility</p>");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      fontSize: "20px",
    } as CSSStyleDeclaration);
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      top: 2,
      bottom: 30,
      left: 2,
      right: 2,
    });
    focusEditor(editor);
    await nextFrame();

    expect(
      editor.view.dom.parentElement?.querySelector<HTMLElement>(
        ".tiptap-compact-caret",
      )?.style.height,
    ).toBe("20px");
  });

  it("leaves the native caret visible when overlay positioning fails", async () => {
    editor = makeEditor("<p>facility</p>");
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation(() => {
      throw new Error("no layout");
    });
    editor.commands.setTextSelection(1 + "facilit".length);
    focusEditor(editor);
    await nextFrame();

    expect(editor.view.dom.classList.contains("tiptap-compact-caret-active")).toBe(
      false,
    );
    expect(
      editor.view.dom.parentElement?.querySelector<HTMLElement>(
        ".tiptap-compact-caret",
      )?.hidden,
    ).toBe(true);
  });
});
