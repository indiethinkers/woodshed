import { Link } from "@tanstack/react-router";

interface TagPillProps {
  tag: string;
  /**
   * Render a non-interactive pill when the tag sits inside another link.
   */
  noLink?: boolean;
}

export function TagPill({ tag, noLink }: TagPillProps) {
  const clean = tag.replace(/^#/, "");
  const className =
    "inline-flex items-center px-1.5 py-0.5 rounded-md text-xs font-medium bg-muted text-muted-foreground transition-colors";

  if (noLink) {
    return <span className={className}>#{clean}</span>;
  }

  return (
    <Link
      to="/databases/tags/$tag"
      params={{ tag: clean }}
      className={`${className} hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15`}
    >
      #{clean}
    </Link>
  );
}
