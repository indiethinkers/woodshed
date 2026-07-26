export function isEditableElement(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  if (
    el.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], .ProseMirror, .tiptap-content",
    )
  ) {
    return true;
  }
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  if (el.getAttribute("role") === "textbox") return true;
  return false;
}
