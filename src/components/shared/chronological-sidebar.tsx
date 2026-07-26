import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ListSidebarSectionHeader } from "@/components/shared/list-sidebar";
import {
  formatShortDate,
  groupByDate,
  type DateGroup,
} from "@/lib/date-grouping";

export interface ChronologicalSidebarItem {
  id: string;
  href: string;
  title: string;
  date: string;
  preview?: string;
  favorite: boolean;
}

/**
 * A compact record navigator for writing-and-reading surfaces. Favorites are
 * pinned once at the top; everything else keeps the familiar Notes-style
 * chronological buckets.
 */
export function ChronologicalSidebar({
  title,
  items,
  referenceDate,
  isLoading = false,
  action,
  toolbar,
  emptyMessage,
  favoriteEmptyMessage,
}: {
  /** Omit when the page title already identifies the surface. */
  title?: string;
  items: ChronologicalSidebarItem[];
  referenceDate: Date;
  isLoading?: boolean;
  action?: ReactNode;
  toolbar?: ReactNode;
  emptyMessage: string;
  favoriteEmptyMessage: string;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { favorites, groups } = organizeChronologicalSidebarItems(
    items,
    referenceDate,
  );

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
          <SidebarSection label="Favorites" count={favorites.length}>
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

          {groups.map((group) => (
            <SidebarSection
              key={group.label}
              label={group.label}
              count={group.items.length}
            >
              {group.items.map((item) => (
                <SidebarRecordRow
                  key={item.id}
                  item={item}
                  active={pathname === item.href}
                />
              ))}
            </SidebarSection>
          ))}
        </div>
      )}
    </section>
  );
}

export function organizeChronologicalSidebarItems(
  items: ChronologicalSidebarItem[],
  referenceDate: Date,
): {
  favorites: ChronologicalSidebarItem[];
  groups: DateGroup<ChronologicalSidebarItem>[];
} {
  const favorites = items
    .filter((item) => item.favorite)
    .sort((a, b) => sortableTime(b.date) - sortableTime(a.date));
  const groups = groupByDate(
    items.filter((item) => !item.favorite),
    (item) => item.date,
    referenceDate,
  );

  return { favorites, groups };
}

function SidebarSection({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-0">
      <ListSidebarSectionHeader label={label} count={count} />
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
              : "text-foreground/72 group-hover:text-foreground/90"
          }`}
        >
          {item.title}
        </div>
        <div
          className={`mt-0.5 flex min-w-0 items-baseline gap-2 truncate text-[12px] transition-colors ${
            active
              ? "text-muted-foreground"
              : "text-muted-foreground/55 group-hover:text-muted-foreground/75"
          }`}
        >
          <span className="shrink-0 tabular-nums">
            {formatShortDate(item.date)}
          </span>
          {item.preview && <span className="truncate">{item.preview}</span>}
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
