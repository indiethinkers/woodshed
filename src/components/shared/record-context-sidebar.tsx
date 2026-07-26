import type { ElementType, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Bookmark,
  Calendar,
  CheckSquare,
  FileQuestion,
  FileText,
  Mail,
  MapPinned,
  NotebookPen,
  Table2,
  Users,
} from "lucide-react";
import {
  ListSidebar,
  ListSidebarSection,
} from "@/components/shared/list-sidebar";
import { useBacklinks } from "@/lib/hooks/use-backlinks";
import { useOutgoingLinks } from "@/lib/hooks/use-outgoing-links";

// Detail-page companion for the middle list panel: the record's graph
// context — Links (outgoing wikilinks) and Backlinks — plus an optional
// surface-specific section. Moving these out of the content column keeps
// the main reading/writing measure for the body.

const typeIcons: Record<string, ElementType> = {
  area: MapPinned,
  daily: NotebookPen,
  event: Calendar,
  note: FileText,
  person: Users,
  resource: Bookmark,
  task: CheckSquare,
  journal: NotebookPen,
  mail: Mail,
  row: Table2,
};

export function RecordContextSidebar({
  id,
  title,
  primaryAction,
  backlinksTitle = "Backlinks",
  backlinksFirst = false,
  afterBacklinks,
}: {
  /** Record id — both the wikilink source and target. */
  id: string;
  /** Header label; usually the record's title. */
  title: string;
  /** Surface-level creation action, kept available while a record is open. */
  primaryAction?: ReactNode;
  backlinksTitle?: string;
  /** Lead with backlinks instead of outgoing links. */
  backlinksFirst?: boolean;
  /** Surface-specific section rendered immediately after backlinks. */
  afterBacklinks?: ReactNode;
}) {
  const { data: outgoing = [] } = useOutgoingLinks(id);
  const { data: backlinks = [] } = useBacklinks(id);
  const empty =
    !afterBacklinks && outgoing.length === 0 && backlinks.length === 0;

  const outgoingSection = outgoing.length > 0 && (
    <ListSidebarSection label="Links" count={outgoing.length}>
      {outgoing.map((link) => (
        <ContextRow
          key={`${link.label}:${link.href ?? "unresolved"}`}
          href={link.href ?? undefined}
          icon={
            typeIcons[link.type ?? ""] ??
            (link.resolved ? FileText : FileQuestion)
          }
          title={link.title ?? link.label}
          hoverTitle={link.href ? undefined : `Unresolved: [[${link.label}]]`}
        />
      ))}
    </ListSidebarSection>
  );

  const backlinksSection = backlinks.length > 0 && (
    <ListSidebarSection label={backlinksTitle} count={backlinks.length}>
      {backlinks.map((bl) => (
        <ContextRow
          key={bl.href}
          href={bl.href}
          title={bl.title}
          meta={bl.preview}
        />
      ))}
    </ListSidebarSection>
  );

  return (
    <ListSidebar title={title}>
      {primaryAction}
      {empty ? (
        <p className="px-1 py-1 text-[13px] leading-snug text-muted-foreground">
          No connections yet. Link this record with{" "}
          <span className="font-mono text-[12px]">[[wikilinks]]</span> and
          they'll collect here.
        </p>
      ) : (
        <>
          {backlinksFirst ? (
            <>
              {backlinksSection}
              {afterBacklinks}
              {outgoingSection}
            </>
          ) : (
            <>
              {outgoingSection}
              {backlinksSection}
              {afterBacklinks}
            </>
          )}
        </>
      )}
    </ListSidebar>
  );
}

// Same anatomy as ListSidebarRow, plus an unresolved (no-href) state —
// unresolved wikilinks render as future placeholders, not errors.
function ContextRow({
  href,
  icon: Icon,
  title,
  meta,
  hoverTitle,
}: {
  href?: string;
  /** Omitted for backlinks — those rows read cleaner without a leading glyph.
   *  Outgoing Links still pass one to signal resolved vs. unresolved state. */
  icon?: ElementType;
  title: string;
  meta?: string;
  hoverTitle?: string;
}) {
  const body = (
    <>
      {Icon && (
        <Icon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13.5px] font-medium leading-[1.35] text-foreground">
          {title || "(untitled)"}
        </span>
        {meta && (
          <span className="mt-[3px] line-clamp-2 block text-[12px] leading-snug text-muted-foreground/80">
            {meta}
          </span>
        )}
      </span>
    </>
  );
  const className = "flex items-start gap-2.5 rounded-lg px-2 py-[7px]";

  if (!href) {
    return (
      <div className={className} title={hoverTitle}>
        {body}
      </div>
    );
  }
  return (
    <Link
      to={href}
      title={hoverTitle ?? title}
      className={`${className} transition-colors hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06]`}
    >
      {body}
    </Link>
  );
}
