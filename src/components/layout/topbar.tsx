import { useRouterState } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { DatePicker } from "@/components/cadence/date-picker";
import { useResolvedRouteTitle } from "@/lib/route-title";
import { cn } from "@/lib/utils";

const viewLabels: Record<string, string> = {
  people: "People",
  mail: "Mail",
  cadence: "Cadence",
  notebook: "Notebook",
  databases: "Databases",
  resources: "Resources",
  areas: "Areas",
  agent: "Agent",
};

/**
 * Breadcrumb row for the content panel. The collapse toggle and tab strip
 * have moved up into the Tauri title-bar (see TitleBar), so this row is
 * now just the breadcrumb trail. It mirrors the content body's gutter
 * (`px-10`) and centered `max-w-detail` column so the breadcrumb's left
 * edge lines up with the page title's X position. Wide views (tables,
 * index pages) skip the column cap and align to the full-width gutter.
 */
export function Topbar({ wide = false }: { wide?: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const segments = pathname.split("/").filter(Boolean);
  const isCalendar = pathname === "/" || segments[0] === "cadence";

  const crumbs: { label: string; href: string; isLast: boolean }[] = [];
  if (segments.length > 0) {
    const view = segments[0];
    const viewLabel = viewLabels[view] ?? view;
    crumbs.push({
      label: viewLabel,
      href: `/${view}`,
      isLast: segments.length === 1,
    });
    if (segments.length > 1) {
      const slug = segments.slice(1).join("/");
      const label = slug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      crumbs.push({ label, href: pathname, isLast: true });
    }
  }

  return (
    <header className="sticky top-0 z-10 shrink-0 bg-content">
      {/* Gradient strip anchored to the header's bottom edge, overlapping the
          first 24px of scrolling content (the pt-6 gap before the title). It
          fades content out as it tucks under the breadcrumb instead of a hard
          clip — mirrors the footer fade. Pure overlay: no layout impact. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-full h-6 bg-gradient-to-b from-content to-content/0"
      />
      <div className="px-10">
        <div
          className={cn(
            // pt-8 (32px) puts the breadcrumb at the same top offset as the
            // Cadence page's first line (its content pt-4 + header pt-4).
            // pb-4 (16px) keeps a permanent buffer below the breadcrumb that
            // the opaque header occupies — so as content scrolls up, it tucks
            // under the bar with breathing room instead of clipping flush
            // against the breadcrumb baseline. The remaining breadcrumb→title
            // gap lives in the content's pt; the two together preserve the
            // original 40px first-paint gap (16px here + 24px content pt).
            "flex items-center pt-8 pb-4",
            !wide && "mx-auto w-full max-w-detail",
          )}
        >
          <nav className="flex items-center gap-1.5 text-sm min-w-0 max-w-full">
            {isCalendar ? (
              <CalendarBreadcrumb segments={segments} />
            ) : (
              crumbs.map((crumb, i) => (
                <span key={i} className="flex items-center gap-1.5 min-w-0">
                  {i > 0 && (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  {crumb.isLast ? (
                    <LeafCrumb pathname={pathname} fallback={crumb.label} />
                  ) : (
                    <Link
                      to={crumb.href}
                      className="text-muted-foreground hover:text-foreground transition-colors truncate"
                    >
                      {crumb.label}
                    </Link>
                  )}
                </span>
              ))
            )}
          </nav>
        </div>
      </div>
    </header>
  );
}

/**
 * Last-segment breadcrumb that picks up the live entity title from the
 * TanStack cache. Falls back to the slug-derived label until the cache
 * loads (or for routes that don't have a known entity, e.g. /areas).
 */
function LeafCrumb({
  pathname,
  fallback,
}: {
  pathname: string;
  fallback: string;
}) {
  const label = useResolvedRouteTitle(pathname, fallback);
  return (
    <span className="text-foreground font-medium truncate max-w-[32rem]">
      {label}
    </span>
  );
}

/**
 * Breadcrumb for the cadence surface — root and /cadence/* routes.
 * Date pages render the DatePicker (which now owns its own ← / →
 * day-navigation arrows alongside the calendar popover), no
 * "Cadence ›" prefix needed. Event detail pages keep the traditional
 * breadcrumb since there's no date to step through.
 * Event and task labels read the entity's title from cache so renames
 * reflect immediately.
 */
function CalendarBreadcrumb({ segments }: { segments: string[] }) {
  const isEventRoute = segments[0] === "cadence" && segments[1] === "event";
  const isTaskRoute = segments[2] === "task";
  const pathname = "/" + segments.join("/");

  if (isEventRoute) {
    return (
      <>
        <Link
          to="/"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          Cadence
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        <LeafCrumb pathname={pathname} fallback="Event" />
      </>
    );
  }

  return (
    <>
      <DatePicker showDayNav={!isTaskRoute} />
      {isTaskRoute && (
        <>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          <LeafCrumb pathname={pathname} fallback="Task" />
        </>
      )}
    </>
  );
}
