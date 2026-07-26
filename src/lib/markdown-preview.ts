// First non-empty paragraph, with common markdown affordances removed and
// line breaks flattened for compact list-row previews.
export function getMarkdownPreview(body: string): string {
  const cleaned = body
    .replace(/\r\n/g, "\n")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s#[a-zA-Z][\w-]*/g, "")
    .trim();
  const firstParagraph = cleaned.split(/\n\s*\n/)[0] ?? cleaned;
  return firstParagraph.replace(/\n/g, " ").trim();
}
