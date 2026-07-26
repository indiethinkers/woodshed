import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  ListSidebar,
  ListSidebarEmpty,
  ListSidebarRow,
  ListSidebarRows,
  ListSidebarSection,
} from "@/components/shared/list-sidebar";

export interface FavoriteItem {
  id: string;
  href: string;
  title: string;
  meta?: string;
  leading?: ReactNode;
}

/**
 * Index-page list panel: the surface's starred records. The index table is
 * the full list, so the panel holds the short one — favorites only.
 */
export function FavoritesSidebar({
  items,
  primaryAction,
}: {
  items: FavoriteItem[];
  primaryAction?: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <ListSidebar>
      {primaryAction}
      <ListSidebarSection label="Favorites" count={items.length}>
        {items.length === 0 ? (
          <ListSidebarEmpty>
            No favorites yet. Hover a row in the table and click the star, or
            star a record from its page.
          </ListSidebarEmpty>
        ) : (
          <ListSidebarRows>
            {items.map((item) => (
              <ListSidebarRow
                key={item.id}
                href={item.href}
                active={pathname === item.href}
                title={item.title}
                meta={item.meta}
                leading={item.leading}
              />
            ))}
          </ListSidebarRows>
        )}
      </ListSidebarSection>
    </ListSidebar>
  );
}
