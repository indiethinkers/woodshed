import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { Wikilink } from "./wikilink";
import { TagPill } from "./tag-pill";

interface RichTextProps {
  text: string;
  /**
   * When true, all child Wikilink and TagPill components render as `<span>`
   * instead of `<Link>`. Pass this when RichText is rendered inside a parent
   * `<Link>` wrapper to avoid nested-anchor hydration errors.
   */
  noLink?: boolean;
}

/**
 * Parses a string and renders [[wikilinks]] and #tags as interactive components.
 * Handles basic newlines as <br />.
 */
export function RichText({ text, noLink }: RichTextProps) {
  // Match (in priority order): inline backtick code, wikilinks, hashtags,
  // standalone ISO dates. Date matches are filtered below so file paths like
  // `/cadence/2026-06-13.md` stay as plain text.
  const pattern = /(`[^`\n]+`)|(\[\[.+?\]\])|(#[a-zA-Z][\w-]*)|(\b\d{4}-\d{2}-\d{2}\b)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Add plain text before this match
    if (match.index > lastIndex) {
      parts.push(renderPlainText(text.slice(lastIndex, match.index), parts.length));
    }

    if (match[1]) {
      // Inline code: `code`
      const code = match[1].slice(1, -1);
      parts.push(
        <code
          key={`c-${parts.length}`}
          className="font-mono text-[0.875em] bg-muted/70 border border-border/60 px-1 py-px rounded-sm"
        >
          {code}
        </code>,
      );
    } else if (match[2]) {
      // Wikilink: [[text]]
      const linkText = match[2].slice(2, -2);
      parts.push(<Wikilink key={`w-${parts.length}`} text={linkText} noLink={noLink} />);
    } else if (match[3]) {
      // Tag: #tagname
      const tag = match[3].slice(1);
      parts.push(<TagPill key={`t-${parts.length}`} tag={tag} noLink={noLink} />);
      parts.push(<span key={`ts-${parts.length}`}> </span>);
    } else if (match[4]) {
      const date = match[4];
      if (isStandaloneIsoDateToken(text, match.index, date)) {
        parts.push(<DateLink date={date} key={`d-${parts.length}`} noLink={noLink} />);
      } else {
        parts.push(renderPlainText(date, parts.length));
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(renderPlainText(text.slice(lastIndex), parts.length));
  }

  return <>{parts}</>;
}

function DateLink({ date, noLink }: { date: string; noLink?: boolean }) {
  const className =
    "pointer-events-auto inline-flex items-baseline rounded-sm border border-border/70 bg-muted/35 px-1 py-0.5 font-mono text-[0.88em] leading-none text-foreground/85 no-underline transition-colors hover:bg-muted hover:text-foreground";

  if (noLink) {
    return <span className={className}>{date}</span>;
  }

  return (
    <Link className={className} params={{ date }} to="/cadence/$date">
      {date}
    </Link>
  );
}

function isStandaloneIsoDateToken(text: string, index: number, date: string): boolean {
  if (!isValidIsoDate(date)) return false;
  const before = index > 0 ? text[index - 1] : "";
  const after = text[index + date.length] ?? "";
  return !/[A-Za-z0-9_./-]/.test(before) && !/[A-Za-z0-9_./-]/.test(after);
}

function isValidIsoDate(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function renderPlainText(text: string, keyBase: number): React.ReactNode {
  const lines = text.split("\n");
  if (lines.length === 1) return <Fragment key={`p-${keyBase}`}>{text}</Fragment>;

  return (
    <Fragment key={`p-${keyBase}`}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {line}
          {i < lines.length - 1 && <br />}
        </Fragment>
      ))}
    </Fragment>
  );
}
