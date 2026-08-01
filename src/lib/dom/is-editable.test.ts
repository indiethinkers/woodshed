import { describe, expect, it } from "vitest";
import { isEditableElement } from "./is-editable";

describe("isEditableElement", () => {
  it("detects descendants inside a ProseMirror editor", () => {
    const editor = document.createElement("div");
    editor.className = "tiptap-content ProseMirror";
    editor.setAttribute("contenteditable", "true");
    const paragraph = document.createElement("p");
    editor.appendChild(paragraph);

    expect(isEditableElement(paragraph)).toBe(true);
  });

  it("detects the active contenteditable host", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");

    expect(isEditableElement(editor)).toBe(true);
  });

  it("treats a focused database cell as an editing surface", () => {
    const cell = document.createElement("div");
    cell.setAttribute("data-table-cell", "");
    const trigger = document.createElement("button");
    cell.appendChild(trigger);

    expect(isEditableElement(trigger)).toBe(true);
  });

  it("ignores inert page elements", () => {
    expect(isEditableElement(document.createElement("div"))).toBe(false);
  });
});
