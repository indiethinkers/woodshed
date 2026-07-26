import { Link } from "@tanstack/react-router";
import { useBacklinks } from "@/lib/hooks/use-backlinks";
import { Separator } from "@/components/ui/separator";

interface BacklinksPanelProps {
  targetId: string;
  /**
   * Section heading. Defaults to "Backlinks" — the Obsidian-native term.
   * The People detail page passes "Mentioned in" to read as natural CRM
   * language; other surfaces can override similarly when the audience
   * benefits from a friendlier word.
   */
  title?: string;
}

export function BacklinksPanel({ targetId, title = "Backlinks" }: BacklinksPanelProps) {
  const { data: backlinks = [] } = useBacklinks(targetId);
  if (backlinks.length === 0) return null;

  return (
    <section className="mt-12">
      <Separator className="mb-6" />
      <h3 className="font-mono text-[13px] text-muted-foreground mb-3 select-none">
        {title}
      </h3>
      <ul className="space-y-2">
        {backlinks.map((bl) => (
          <li key={bl.href}>
            <Link
              to={bl.href}
              className="block group rounded-sm -mx-2 px-2 py-1 hover:bg-foreground/[0.03] transition-colors"
            >
              <div className="flex items-baseline gap-2 text-[14px] text-muted-foreground group-hover:text-foreground transition-colors">
                <span className="truncate">{bl.title}</span>
                <span className="font-mono text-[11px] text-muted-foreground/70 ml-auto shrink-0">
                  {bl.source}
                </span>
              </div>
              {bl.preview && (
                <p className="mt-1 text-[13px] text-muted-foreground/80 group-hover:text-muted-foreground line-clamp-2 leading-snug transition-colors">
                  {bl.preview}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
