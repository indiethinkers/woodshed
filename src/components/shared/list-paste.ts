import type { Editor } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";

/**
 * If `text` is a single pasted URL, return the canonical href (adding a
 * `https://` scheme to scheme-less `www.`/`domain.tld/path` forms); otherwise
 * `null`. Deliberately conservative: a bare `domain.tld` with no scheme, no
 * `www.`, and no path is left alone so prose fragments (file names,
 * abbreviations) selected-and-pasted don't get turned into links.
 */
export function pastedUrl(text: string): string | null {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;

  // Explicit scheme — the unambiguous case (copied from an address bar).
  if (/^https?:\/\//i.test(value)) {
    return isParseableHttpUrl(value) ? value : null;
  }
  // Scheme-less but clearly a link: `www.…`, or a `domain.tld/path`.
  if (/^www\.[^\s.]+\.[^\s]+$/i.test(value) || /^[^\s/]+\.[a-z]{2,}\/\S*$/i.test(value)) {
    const withScheme = `https://${value}`;
    return isParseableHttpUrl(withScheme) ? withScheme : null;
  }
  return null;
}

function isParseableHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

/**
 * Paste a URL over a non-empty selection → wrap the selected text in an
 * external link rather than replacing it with the raw URL. Mirrors the
 * Notion / Google Docs behavior. Returns `true` when it handled the paste.
 */
export function linkSelectionWithPastedUrl(editor: Editor, text: string): boolean {
  if (!editor.schema.marks.link) return false;
  if (editor.state.selection.empty) return false;
  const href = pastedUrl(text);
  if (!href) return false;
  return editor.chain().focus().setLink({ href }).run();
}

export function plainTextParagraphBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!/\n[ \t]*\n/.test(normalized)) return [];
  return normalized
    .split(/\n[ \t]*\n+/)
    .map((block) => normalizeWrappedProseBlock(block) ?? block.trim())
    .filter(Boolean);
}

export function normalizeWrappedPlainText(text: string): string | null {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.includes("\n") || hasCodeFence(normalized)) return null;

  let changed = false;
  const next = normalized
    .split(/(\n[ \t]*\n+)/)
    .map((part) => {
      if (/^\n[ \t]*\n+$/.test(part)) return part;
      const unwrapped = normalizeWrappedProseBlock(part);
      if (unwrapped === null) return part;
      changed = true;
      return unwrapped;
    })
    .join("");

  return changed ? next : null;
}

export function insertNormalizedPlainTextPaste(
  editor: Editor,
  text: string,
): boolean {
  const normalized = normalizeWrappedPlainText(text);
  if (!normalized) return false;
  return editor.chain().focus().insertContent(normalized).run();
}

export function insertPlainTextParagraphsAsListItems(
  editor: Editor,
  text: string,
): boolean {
  const blocks = plainTextParagraphBlocks(text);
  if (blocks.length < 2 || !selectionIsInsideListItem(editor)) return false;

  for (const [index, block] of blocks.entries()) {
    if (index > 0 && !editor.commands.splitListItem("listItem")) return false;
    if (!editor.chain().focus().insertContent(block).run()) return false;
  }
  return true;
}

function selectionIsInsideListItem(editor: Editor): boolean {
  const listItemType = editor.state.schema.nodes.listItem;
  if (!listItemType) return false;
  const { $from, $to } = editor.state.selection;
  if ($from.sameParent($to)) return depthHasListItem($from);
  return depthHasListItem($from) && depthHasListItem($to);
}

function depthHasListItem(pos: ResolvedPos) {
  for (let depth = pos.depth; depth > 0; depth -= 1) {
    if (pos.node(depth).type.name === "listItem") return true;
  }
  return false;
}

function normalizeWrappedProseBlock(block: string): string | null {
  const rawLines = block.split("\n").filter((line) => line.trim());
  const lines = rawLines
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || !looksLikeWrappedProse(rawLines)) return null;
  return lines.join(" ");
}

function looksLikeWrappedProse(lines: string[]): boolean {
  const trimmed = lines.map((line) => line.trim());
  if (lines.some((line, index) => !isPlainProseLine(line, trimmed[index]))) {
    return false;
  }
  const nonFinalLengths = trimmed.slice(0, -1).map((line) => line.length);
  if (nonFinalLengths.length === 0) return false;
  const hasLongWrappedLine = nonFinalLengths.some((length) => length >= 50);
  const avgNonFinal =
    nonFinalLengths.reduce((sum, length) => sum + length, 0) /
    nonFinalLengths.length;
  const hasContinuationStart = trimmed
    .slice(1)
    .some((line) => /^[a-z(]/.test(line));
  return (
    hasLongWrappedLine ||
    avgNonFinal >= 45 ||
    (hasContinuationStart && avgNonFinal >= 30)
  );
}

function isPlainProseLine(rawLine: string, line: string): boolean {
  return !(
    /^#{1,6}\s/.test(line) ||
    /^>\s?/.test(line) ||
    /^([-*+]|\d+[.)])\s+/.test(line) ||
    /^[-*_]{3,}\s*$/.test(line) ||
    /^https?:\/\//i.test(line) ||
    /^\|.*\|$/.test(line) ||
    /^\s{4,}/.test(rawLine) ||
    / {2}$/.test(rawLine)
  );
}

function hasCodeFence(text: string): boolean {
  return /(^|\n)(```|~~~)/.test(text);
}
