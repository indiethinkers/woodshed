import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "prosemirror-model";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import type { MarkdownNodeSpec } from "tiptap-markdown";

const TRANSCRIPT_TAGS = new Set(["P", "BR", "STRONG", "B", "EM", "I"]);

/** Keep transcript text and basic emphasis, dropping every attribute and
 * executable/embedded element. Vault files are untrusted input: another app,
 * sync provider, or imported repository can edit them outside Woodshed. */
export function sanitizeTranscriptHtml(raw: string): string {
  const source = new DOMParser().parseFromString(raw, "text/html").body;
  const output = document.createElement("div");
  const copySafe = (node: globalThis.Node, parent: HTMLElement) => {
    if (node.nodeType === globalThis.Node.TEXT_NODE) {
      parent.append(document.createTextNode(node.textContent ?? ""));
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (!TRANSCRIPT_TAGS.has(node.tagName)) {
      if (!["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED"].includes(node.tagName)) {
        for (const child of Array.from(node.childNodes)) copySafe(child, parent);
      }
      return;
    }
    const safe = document.createElement(node.tagName.toLowerCase());
    for (const child of Array.from(node.childNodes)) copySafe(child, safe);
    parent.append(safe);
  };
  for (const child of Array.from(source.childNodes)) copySafe(child, output);
  return output.innerHTML;
}

function appendTranscriptBody(parent: HTMLElement, raw: string) {
  const safe = new DOMParser().parseFromString(
    sanitizeTranscriptHtml(raw),
    "text/html",
  ).body;
  for (const child of Array.from(safe.childNodes)) {
    parent.append(child.cloneNode(true));
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A collapsible meeting transcript. Meeting recordings append a (potentially
 * very long) speaker-labeled transcript to the event note; folding it keeps the
 * page readable. The transcript is a *derived, read-only* artifact — the user
 * never edits it by hand — so it's stored as an opaque HTML blob in a single
 * attribute rather than as editable ProseMirror content. That makes it:
 *   - immune to the editor's content normalization (no risk of mangling), and
 *   - a clean round-trip: parsed verbatim from the on-disk `<details>` block and
 *     re-serialized verbatim.
 *
 * On disk it lives in the markdown body as one HTML block:
 *   `<details data-woodshed-transcript><summary>Transcript</summary>…</details>`
 * which also renders as a native fold in plain-markdown viewers (Obsidian,
 * GitHub). Parsing requires the host editor to enable `html` in tiptap-markdown
 * (the `allowHtml` TiptapEditor prop) — only the event-notes editors do.
 */
export const MeetingTranscript = Node.create({
  name: "meetingTranscript",

  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      // The transcript body as inner HTML (a run of <p> lines). Opaque: stored
      // verbatim, rendered via the NodeView, re-emitted verbatim on serialize.
      html: { default: "" },
      label: { default: "Transcript" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "details[data-woodshed-transcript]",
        getAttrs: (el) => {
          const node = el as HTMLElement;
          const label =
            node.querySelector("summary")?.textContent?.trim() || "Transcript";
          // Everything inside the <details> except the <summary> is the body.
          const clone = node.cloneNode(true) as HTMLElement;
          clone.querySelector("summary")?.remove();
          return { html: sanitizeTranscriptHtml(clone.innerHTML.trim()), label };
        },
      },
    ];
  },

  renderHTML({ node }) {
    // ProseMirror DOM spec (clipboard / getHTML). The on-screen render is owned
    // by the NodeView below; here we just emit the wrapper + summary. The body
    // HTML can't be injected through the spec array (it escapes), so a
    // clipboard copy of the node carries the heading but not the lines — an
    // acceptable edge since the markdown round-trip goes through `serialize`.
    return [
      "details",
      mergeAttributes({ "data-woodshed-transcript": "" }),
      ["summary", {}, (node.attrs.label as string) || "Transcript"],
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("details");
      dom.setAttribute("data-woodshed-transcript", "");
      dom.className = "wd-transcript";
      dom.contentEditable = "false";

      const summary = document.createElement("summary");
      summary.className = "wd-transcript-summary";
      summary.textContent = (node.attrs.label as string) || "Transcript";

      const body = document.createElement("div");
      body.className = "wd-transcript-body";
      appendTranscriptBody(body, (node.attrs.html as string) || "");

      dom.append(summary, body);
      // Atom node — no contentDOM (nothing editable inside).
      return { dom };
    };
  },

  addStorage() {
    const spec: MarkdownNodeSpec = {
      serialize(state: MarkdownSerializerState, node: PMNode) {
        const label = escapeHtml((node.attrs.label as string) || "Transcript");
        const html = sanitizeTranscriptHtml((node.attrs.html as string) || "");
        // One line, no internal blank lines, so markdown-it (html: true) re-reads
        // it as a single HTML block rather than splitting it into open/close
        // fragments around the paragraphs.
        state.write(
          `<details data-woodshed-transcript><summary>${label}</summary>${html}</details>`,
        );
        state.closeBlock(node);
      },
      parse: {},
    };
    return { markdown: spec };
  },
});
