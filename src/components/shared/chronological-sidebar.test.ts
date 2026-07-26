import { describe, expect, it } from "vitest";
import {
  organizeChronologicalSidebarItems,
  type ChronologicalSidebarItem,
} from "./chronological-sidebar";

const referenceDate = new Date("2026-07-22T00:00:00");

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

describe("organizeChronologicalSidebarItems", () => {
  it("pins favorites once and keeps the remaining records date-grouped", () => {
    const result = organizeChronologicalSidebarItems(
      [
        item("yesterday", "2026-07-21T09:00:00"),
        item("favorite-old", "2026-06-01T09:00:00", true),
        item("favorite-new", "2026-07-20T09:00:00", true),
        item("last-week", "2026-07-17T09:00:00"),
      ],
      referenceDate,
    );

    expect(result.favorites.map(({ id }) => id)).toEqual([
      "favorite-new",
      "favorite-old",
    ]);
    expect(result.groups.map(({ label }) => label)).toEqual([
      "Yesterday",
      "Previous 7 Days",
    ]);
    expect(
      result.groups.flatMap(({ items }) => items.map(({ id }) => id)),
    ).toEqual(["yesterday", "last-week"]);
  });
});
