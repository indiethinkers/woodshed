import { RichText } from "./rich-text";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import {
  parseMarkdownToBlocks,
  type EditorBlock,
} from "@/lib/markdown-blocks";
import { FileCode2 } from "lucide-react";
import { bundledLanguages, type BundledLanguage } from "shiki";
import { TwitterEmbed } from "./extensions/twitter-embed";
import { YoutubeFacade } from "./extensions/youtube-facade";

interface MarkdownProps {
  text: string;
  className?: string;
  preserveSoftBreaks?: boolean;
}

/**
 * Block-level markdown renderer for body prose: paragraphs, unordered and
 * ordered lists, blockquotes, YouTube embeds. Inline content (links, tags,
 * backtick code) delegates to `RichText`.
 *
 * Block parsing is shared with the editor (`@/lib/markdown-blocks`); this
 * renderer just collapses contiguous bullet/ordered editor blocks back
 * into a single <ul>/<ol> for display.
 */
export function Markdown({
  text,
  className,
  preserveSoftBreaks = false,
}: MarkdownProps) {
  const blocks = parseMarkdownToBlocks(text, { preserveSoftBreaks });
  const groups = groupListBlocks(blocks);
  return (
    <div className={className}>
      {groups.map((group, i) => renderGroup(group, i))}
    </div>
  );
}

type RenderGroup =
  | { kind: "paragraph"; text: string }
  | { kind: "sectionHeader"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; code: string; language?: string }
  | {
      kind: "youtube";
      videoId: string;
      title?: string;
      resource?: boolean;
    }
  | {
      kind: "twitter";
      url: string;
      tweetId: string;
      handle: string;
    };

function groupListBlocks(blocks: EditorBlock[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (block.kind === "bullet") {
      if (last && last.kind === "list" && !last.ordered) {
        last.items.push(block.text);
      } else {
        groups.push({ kind: "list", ordered: false, items: [block.text] });
      }
    } else if (block.kind === "ordered") {
      if (last && last.kind === "list" && last.ordered) {
        last.items.push(block.text);
      } else {
        groups.push({ kind: "list", ordered: true, items: [block.text] });
      }
    } else if (block.kind === "paragraph") {
      groups.push({ kind: "paragraph", text: block.text });
    } else if (block.kind === "sectionHeader") {
      groups.push({ kind: "sectionHeader", text: block.text });
    } else if (block.kind === "quote") {
      groups.push({ kind: "quote", text: block.text });
    } else if (block.kind === "code") {
      groups.push({
        kind: "code",
        code: block.code,
        language: block.language,
      });
    } else if (block.kind === "youtube") {
      groups.push({
        kind: "youtube",
        videoId: block.videoId,
        title: block.title,
        resource: block.resource,
      });
    } else if (block.kind === "twitter") {
      groups.push({
        kind: "twitter",
        url: block.url,
        tweetId: block.tweetId,
        handle: block.handle,
      });
    }
  }
  return groups;
}

function renderGroup(group: RenderGroup, key: number): React.ReactNode {
  switch (group.kind) {
    case "paragraph":
      return (
        <p key={key} className="my-4 first:mt-0 last:mb-0">
          <RichText text={group.text} />
        </p>
      );
    case "sectionHeader":
      return (
        <div
          key={key}
          className="my-8 first:mt-0 last:mb-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6"
        >
          <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.16em] leading-none text-muted-foreground">
            <RichText text={group.text} />
          </h2>
          <div aria-hidden="true" className="h-px bg-border" />
        </div>
      );
    case "list": {
      const Tag = group.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          className={`my-4 first:mt-0 last:mb-0 pl-6 space-y-1.5 ${
            group.ordered ? "list-decimal" : "list-disc"
          } marker:text-muted-foreground`}
        >
          {group.items.map((item, i) => (
            <li key={i} className="pl-1">
              <RichText text={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote
          key={key}
          className="my-4 first:mt-0 last:mb-0 pl-4 border-l-2 border-border italic text-muted-foreground"
        >
          <RichText text={group.text} />
        </blockquote>
      );
    case "code": {
      const language = toBundledLanguage(group.language);
      const label = group.language?.trim() || "code";
      return (
        <div key={key} className="my-5 first:mt-0 last:mb-0">
          <CodeBlock code={group.code} language={language} showLineNumbers>
            <CodeBlockHeader className="bg-muted/55">
              <CodeBlockTitle>
                <FileCode2 className="size-3.5" strokeWidth={1.8} />
                <CodeBlockFilename>{label}</CodeBlockFilename>
              </CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton
                  className="size-7 text-muted-foreground hover:text-foreground"
                  timeout={1400}
                />
              </CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
        </div>
      );
    }
    case "youtube":
      // Same bare click-to-load facade the Tiptap editor shows, so the
      // sidebar / mail read-only views match the main content area.
      return (
        <YoutubeFacade
          key={key}
          url={`https://www.youtube.com/watch?v=${group.videoId}`}
          videoId={group.videoId}
        />
      );
    case "twitter":
      return (
        <TwitterEmbed
          key={key}
          url={group.url}
          tweetId={group.tweetId}
          handle={group.handle}
        />
      );
  }
}

const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
  bash: "shellscript",
  console: "shellscript",
  js: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  sh: "shellscript",
  shell: "shellscript",
  ts: "typescript",
  txt: "shellscript",
  yml: "yaml",
  zsh: "shellscript",
};

function toBundledLanguage(language?: string): BundledLanguage {
  const normalized = language?.trim().toLowerCase();
  const candidate = normalized
    ? (SHIKI_LANGUAGE_ALIASES[normalized] ?? normalized)
    : "shellscript";
  return (
    Object.prototype.hasOwnProperty.call(bundledLanguages, candidate)
      ? candidate
      : "shellscript"
  ) as BundledLanguage;
}
