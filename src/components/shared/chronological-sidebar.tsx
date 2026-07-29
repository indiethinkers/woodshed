import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ListSidebarSectionHeader } from "@/components/shared/list-sidebar";
import { formatShortDate } from "@/lib/date-grouping";

export interface ChronologicalSidebarItem {
  id: string;
  href: string;
  title: string;
  date: string;
  preview?: string;
  favorite: boolean;
}

/**
 * A compact record navigator for writing-and-reading surfaces. The sidebar is
 * intentionally limited to favorites; the adjacent database remains the
 * complete index for browsing every record.
 */
export function ChronologicalSidebar({
  title,
  items,
  isLoading = false,
  action,
  toolbar,
  emptyMessage,
  favoriteEmptyMessage,
}: {
  /** Omit when the page title already identifies the surface. */
  title?: string;
  items: ChronologicalSidebarItem[];
  isLoading?: boolean;
  action?: ReactNode;
  toolbar?: ReactNode;
  emptyMessage: string;
  favoriteEmptyMessage: string;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const favorites = favoriteChronologicalSidebarItems(items);

  return (
    <section className={title ? "px-3 py-3" : "px-4 py-4"}>
      {title && (
        <header className="mb-3 flex items-center px-2">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {title}
          </h2>
        </header>
      )}

      {action}

      {toolbar && <div className="mb-4 px-2">{toolbar}</div>}

      {isLoading ? (
        <SidebarSkeleton />
      ) : items.length === 0 ? (
        <p className="px-2 py-3 text-[13px] italic text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <div>
          <SidebarSection label="Favorites">
            {favorites.length > 0 ? (
              favorites.map((item) => (
                <SidebarRecordRow
                  key={item.id}
                  item={item}
                  active={pathname === item.href}
                />
              ))
            ) : (
              <li>
                <p className="px-3 py-2.5 text-[12px] leading-snug text-muted-foreground/80">
                  {favoriteEmptyMessage}
                </p>
              </li>
            )}
          </SidebarSection>

        </div>
      )}
    </section>
  );
}

export function favoriteChronologicalSidebarItems(
  items: ChronologicalSidebarItem[],
): ChronologicalSidebarItem[] {
  return items
    .filter((item) => item.favorite)
    .sort((a, b) => sortableTime(b.date) - sortableTime(a.date));
}

function SidebarSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-0">
      <ListSidebarSectionHeader label={label} />
      <ul className="divide-y divide-border/30">{children}</ul>
    </section>
  );
}

function SidebarRecordRow({
  item,
  active,
}: {
  item: ChronologicalSidebarItem;
  active: boolean;
}) {
  return (
    <li>
      <Link
        to={item.href}
        aria-current={active ? "page" : undefined}
        className={`group relative block rounded-md px-3 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground/15 ${
          active
            ? "bg-foreground/[0.055]"
            : "hover:bg-foreground/[0.035] dark:hover:bg-foreground/[0.055]"
        }`}
      >
        {active && (
          <span
            aria-hidden
            className="absolute bottom-1.5 left-0 top-1.5 w-[2px] rounded-full bg-foreground/35"
          />
        )}
        <div
          title={item.title}
          className={`truncate text-[13px] font-medium leading-snug transition-colors ${
            active
              ? "text-foreground"
              : "text-foreground/90 group-hover:text-foreground"
          }`}
        >
          {item.title}
        </div>
        <div
          className={`mt-1 flex min-w-0 items-start gap-2 text-[12px] transition-colors ${
            active
              ? "text-muted-foreground/90"
              : "text-muted-foreground/80 group-hover:text-muted-foreground"
          }`}
        >
          <span className="shrink-0 tabular-nums">
            {formatShortDate(item.date)}
          </span>
          {item.preview && (
            <span className="min-w-0 line-clamp-2 leading-[1.35]">
              {item.preview}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

function SidebarSkeleton() {
  return (
    <div className="animate-pulse space-y-2 px-2 pt-2" aria-hidden>
      <div className="h-5 w-24 rounded bg-muted" />
      <div className="h-14 rounded bg-muted" />
      <div className="h-14 rounded bg-muted" />
      <div className="mt-5 h-5 w-32 rounded bg-muted" />
      <div className="h-14 rounded bg-muted" />
    </div>
  );
}

function sortableTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
