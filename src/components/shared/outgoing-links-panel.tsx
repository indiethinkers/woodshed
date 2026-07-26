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
import { useOutgoingLinks } from "@/lib/hooks/use-outgoing-links";

const typeIcons = {
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

interface OutgoingLinksPanelProps {
  sourceId: string;
  title?: string;
}

export function OutgoingLinksPanel({
  sourceId,
  title = "Links",
}: OutgoingLinksPanelProps) {
  const { data: links = [] } = useOutgoingLinks(sourceId);
  if (links.length === 0) return null;

  return (
    <section className="mt-12">
      <h3 className="mb-3 select-none font-mono text-[13px] text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-2">
        {links.map((link) => {
          const Icon =
            typeIcons[link.type as keyof typeof typeIcons] ??
            (link.resolved ? FileText : FileQuestion);
          const body = (
            <div className="flex items-baseline gap-2 text-[14px] text-muted-foreground transition-colors group-hover:text-foreground">
              <Icon className="h-3 w-3 shrink-0 translate-y-px" />
              <span className="truncate">
                {link.title ?? link.label}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/70">
                {link.path ?? "unresolved"}
              </span>
            </div>
          );
          return (
            <li key={`${link.label}:${link.href ?? "unresolved"}`}>
              {link.href ? (
                <Link
                  to={link.href}
                  className="group block rounded-sm -mx-2 px-2 py-1 transition-colors hover:bg-foreground/[0.03]"
                >
                  {body}
                </Link>
              ) : (
                <div
                  className="group block rounded-sm -mx-2 px-2 py-1"
                  title={`Unresolved: [[${link.label}]]`}
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
