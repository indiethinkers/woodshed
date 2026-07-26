import { Link } from "@tanstack/react-router";
import { resolveWikilink } from "@/lib/wikilinks";
import { parseWikilinkInner } from "./extensions/wikilink";

interface WikilinkProps {
  /**
   * Raw inner text from `[[…]]` — may be a plain `Name` or an aliased
   * `Target|display`. Aliases resolve/navigate by the target but render
   * the display text.
   */
  text: string;
  /**
   * When true, render as a non-interactive `<span>` instead of a `<Link>`.
   * Use this when Wikilink is rendered inside a wrapping `<Link>` (e.g.,
   * a list-row link), since nested `<a>` elements are invalid HTML and
   * trigger a hydration mismatch.
   */
  noLink?: boolean;
}

/**
 * Renders a [[wikilink]] as a clickable link with a warm-toned underline.
 *
 * No brackets in the rendered output, no chromatic accent — premium-tool-buyer
 * ICP rejects shadcn-default look-and-feel, so wikilinks read as part of the
 * prose, with a subtle warm underline that stays consistent in light + dark mode.
 *
 * Unresolved wikilinks (the target doesn't exist in the vault index) render as
 * plain text with a dotted muted underline. They're still readable, just not
 * navigable — Woodshed treats unresolved wikilinks as future placeholders, not errors.
 */
export function Wikilink({ text, noLink }: WikilinkProps) {
  // `text` is the raw `[[…]]` inner. Split off an alias so we resolve by the
  // target but display the alias.
  const { text: alias, target: aliasTarget } = parseWikilinkInner(text);
  const resolveKey = aliasTarget ?? alias;
  const target = resolveWikilink(resolveKey);

  // Carry the wikilink identity on the rendered element so copying it and
  // pasting into the Tiptap editor round-trips back into a wikilink node
  // (the editor's parseHTML matches `[data-wikilink]`). Without this the
  // clipboard anchor is just an `<a href>` and degrades into a plain
  // markdown link that no longer resolves or navigates.
  const wikilinkData: Record<string, string> = {
    "data-wikilink": "",
    "data-text": aliasTarget ? alias : (target?.label ?? alias),
  };
  if (aliasTarget) wikilinkData["data-target"] = aliasTarget;

  if (!target) {
    return (
      <span
        {...wikilinkData}
        className="underline underline-offset-2 decoration-muted-foreground/40 decoration-dotted"
        title={`Unresolved: [[${resolveKey}]]`}
      >
        {alias}
      </span>
    );
  }

  // Show the alias when one was given; otherwise fall back to the resolver's
  // canonical title (so `[[alex-rivera]]` still renders "Alex Rivera").
  const display = aliasTarget ? alias : target.label;

  // `pointer-events-auto` lets resolved wikilinks stay clickable even when an
  // ancestor disables pointer events (e.g. task cards, where the card-wide
  // navigation link is an absolute overlay). The hover background gives the
  // wikilink its own click affordance so it reads as a separate target from
  // whatever container it's embedded in.
  const className =
    "pointer-events-auto rounded-sm px-0.5 -mx-0.5 text-foreground underline underline-offset-[3px] decoration-1 decoration-[var(--wikilink-underline)] hover:bg-foreground/[0.06] hover:decoration-[var(--wikilink-underline-hover)] transition-colors";

  if (noLink) {
    return (
      <span {...wikilinkData} className={className}>
        {display}
      </span>
    );
  }

  return (
    <Link {...wikilinkData} to={target.href} className={className}>
      {display}
    </Link>
  );
}
