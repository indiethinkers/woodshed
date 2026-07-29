import { describe, expect, it } from "vitest";
import {
  favoriteChronologicalSidebarItems,
  type ChronologicalSidebarItem,
} from "./chronological-sidebar";

function item(
  id: string,
  date: string,
  favorite = false,
): ChronologicalSidebarItem {
  return {
    id,
    href: `/notebook/${id}`,
    title: id,
    date,
    favorite,
  };
}

describe("favoriteChronologicalSidebarItems", () => {
  it("returns only favorites in newest-first order", () => {
    const result = favoriteChronologicalSidebarItems([
      item("yesterday", "2026-07-21T09:00:00"),
      item("favorite-old", "2026-06-01T09:00:00", true),
      item("favorite-new", "2026-07-20T09:00:00", true),
      item("last-week", "2026-07-17T09:00:00"),
    ]);

    expect(result.map(({ id }) => id)).toEqual([
      "favorite-new",
      "favorite-old",
    ]);
  });
});
