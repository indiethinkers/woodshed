import { tweetUrlParts } from "./twitter";

/**
 * Block model used by the editor and the renderer. Markdown is the
 * on-disk format; this module converts between markdown and a flat
 * editor-friendly block array.
 *
 * Editor blocks are flat: each list item is its own block, so the
 * cursor and keyboard handlers can treat one item as one row. The
 * renderer in `markdown.tsx` collapses contiguous bullet/ordered
 * blocks back into a single <ul>/<ol> for display.
 */

export type EditorBlock =
  | { id: string; kind: "paragraph"; text: string }
  | { id: string; kind: "sectionHeader"; text: string }
  | { id: string; kind: "bullet"; text: string }
  | { id: string; kind: "ordered"; text: string }
  | { id: string; kind: "quote"; text: string }
  | { id: string; kind: "code"; code: string; language?: string }
  | {
      id: string;
      kind: "youtube";
      videoId: string;
      /** Free-form title written above the URL in markdown. Mutually
       *  exclusive with `resource: true` (the resource prelude collapses
       *  into the embed without becoming a title). */
      title?: string;
      /** Set when the URL was preceded by a `#resource #youtube` prelude.
       *  The renderer shows the resource-card chrome (pills) instead of
       *  the title figcaption. */
      resource?: boolean;
    }
  | {
      id: string;
      kind: "twitter";
      url: string;
      tweetId: string;
      handle: string;
    };

interface ParseMarkdownOptions {
  /** Keep intentional single newlines inside prose blocks instead of treating
   * them as Markdown soft wraps. Useful for plain-text model responses. */
  preserveSoftBreaks?: boolean;
}

const BULLET_RE = /^[-*]\s+/;
const ORDERED_RE = /^\d+\.\s+/;
const SECTION_HEADER_RE = /^######\s*(.*)$/;
const FENCED_CODE_RE = /^```(.*)$/;
export const YOUTUBE_URL_RE =
  /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&]\S*)?$/;
const YOUTUBE_RESOURCE_PRELUDE_RE =
  /^\s*(?:#resource\s+#youtube|#youtube\s+#resource)\s*$/;

let blockIdSeq = 0;
export function genBlockId(): string {
  blockIdSeq += 1;
  return `b${blockIdSeq}_${Date.now().toString(36)}`;
}

export function parseMarkdownToBlocks(
  input: string,
  options: ParseMarkdownOptions = {},
): EditorBlock[] {
  const lines = input.split("\n");
  const blocks: EditorBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fencedCode = line.match(FENCED_CODE_RE);
    if (fencedCode) {
      const info = fencedCode[1].trim();
      const language = info ? info.split(/\s+/)[0] : undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].trim().startsWith("```")) {
        i++;
      }
      blocks.push({
        id: genBlockId(),
        kind: "code",
        code: codeLines.join("\n"),
        language,
      });
      continue;
    }

    const sectionHeader = line.match(SECTION_HEADER_RE);
    if (sectionHeader) {
      blocks.push({
        id: genBlockId(),
        kind: "sectionHeader",
        text: sectionHeader[1].trim(),
      });
      i++;
      continue;
    }

    if (BULLET_RE.test(line)) {
      blocks.push({
        id: genBlockId(),
        kind: "bullet",
        text: line.replace(BULLET_RE, ""),
      });
      i++;
      continue;
    }

    if (ORDERED_RE.test(line)) {
      blocks.push({
        id: genBlockId(),
        kind: "ordered",
        text: line.replace(ORDERED_RE, ""),
      });
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({
        id: genBlockId(),
        kind: "quote",
        text: quoteLines.join(" "),
      });
      continue;
    }

    const urlText = standaloneAutolinkText(line);
    const ytMatch = urlText.match(YOUTUBE_URL_RE);
    if (ytMatch) {
      // If the immediately preceding emitted block is the resource prelude
      // paragraph, swap it out for a single resource-flavored youtube
      // block. This keeps round-trip identity with the editor's two-paragraph
      // serializer (`#resource #youtube` + URL).
      const prev = blocks[blocks.length - 1];
      if (
        prev &&
        prev.kind === "paragraph" &&
        YOUTUBE_RESOURCE_PRELUDE_RE.test(prev.text)
      ) {
        blocks[blocks.length - 1] = {
          id: prev.id,
          kind: "youtube",
          videoId: ytMatch[1],
          resource: true,
        };
      } else {
        blocks.push({ id: genBlockId(), kind: "youtube", videoId: ytMatch[1] });
      }
      i++;
      continue;
    }

    const tweetParts = tweetUrlParts(urlText);
    if (tweetParts) {
      blocks.push({
        id: genBlockId(),
        kind: "twitter",
        url: urlText,
        tweetId: tweetParts.tweetId,
        handle: tweetParts.handle,
      });
      i++;
      continue;
    }

    // Paragraph: gather consecutive non-block lines.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !BULLET_RE.test(lines[i]) &&
      !ORDERED_RE.test(lines[i]) &&
      !SECTION_HEADER_RE.test(lines[i]) &&
      !FENCED_CODE_RE.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      !YOUTUBE_URL_RE.test(standaloneAutolinkText(lines[i])) &&
      !tweetUrlParts(standaloneAutolinkText(lines[i]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length === 0) {
      blocks.push({ id: genBlockId(), kind: "paragraph", text: line });
      i++;
      continue;
    }
    const paraText = paraLines.join(options.preserveSoftBreaks ? "\n" : " ");

    // If the next non-blank line is a YouTube URL, this paragraph is
    // its title — emit a single youtube block and skip ahead.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length) {
      const ytNext = standaloneAutolinkText(lines[j]).match(YOUTUBE_URL_RE);
      if (ytNext) {
        if (YOUTUBE_RESOURCE_PRELUDE_RE.test(paraText)) {
          blocks.push({
            id: genBlockId(),
            kind: "youtube",
            videoId: ytNext[1],
            resource: true,
          });
        } else {
          blocks.push({
            id: genBlockId(),
            kind: "youtube",
            videoId: ytNext[1],
            title: paraText,
          });
        }
        i = j + 1;
        continue;
      }
    }
    blocks.push({ id: genBlockId(), kind: "paragraph", text: paraText });
  }

  if (blocks.length === 0) {
    blocks.push({ id: genBlockId(), kind: "paragraph", text: "" });
  }

  return blocks;
}

function standaloneAutolinkText(line: string): string {
  const trimmed = line.trim();
  const match = trimmed.match(/^<([^<>\s]+)>$/);
  return match ? match[1] : trimmed;
}
