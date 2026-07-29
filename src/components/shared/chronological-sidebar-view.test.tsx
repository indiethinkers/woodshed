import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: () => "/notebook",
}));

import { ChronologicalSidebar } from "./chronological-sidebar";

it("starts with the primary action when its redundant surface title is omitted", () => {
  render(
    <ChronologicalSidebar
      action={<button type="button">New note</button>}
      emptyMessage="No notes"
      favoriteEmptyMessage="No favorites"
      items={[]}
    />,
  );

  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  expect(screen.getByRole("button", { name: "New note" })).toBeTruthy();
});

it("shows only favorites with brighter two-line rows", () => {
  render(
    <ChronologicalSidebar
      emptyMessage="No notes"
      favoriteEmptyMessage="No favorites"
      items={[
        {
          id: "unstarred-alpha",
          href: "/notebook/unstarred-alpha",
          title: "Orchard irrigation plan",
          date: "2030-03-16T09:00:00",
          preview: "Pressure readings from the north field",
          favorite: false,
        },
        {
          id: "unstarred-beta",
          href: "/notebook/unstarred-beta",
          title: "Ceramics glaze experiments",
          date: "2030-03-15T08:00:00",
          preview: "Test tiles awaiting a second firing",
          favorite: false,
        },
        {
          id: "favorite",
          href: "/notebook/favorite",
          title: "Pinned telescope checklist",
          date: "2030-03-14T09:00:00",
          preview: "Eyepieces, filters, and alignment notes",
          favorite: true,
        },
      ]}
    />,
  );

  expect(screen.queryByText("01")).toBeNull();
  expect(screen.queryByText("02")).toBeNull();

  expect(screen.queryByText("Orchard irrigation plan")).toBeNull();
  expect(screen.queryByText("Ceramics glaze experiments")).toBeNull();

  const favoriteRow = screen.getByRole("link", {
    name: /Pinned telescope checklist/,
  });
  expect(within(favoriteRow).getByText("3/14/30")).toBeTruthy();
  expect(within(favoriteRow).getByText("Pinned telescope checklist")).toHaveClass(
    "text-foreground/90",
  );
  const preview = within(favoriteRow).getByText(
    "Eyepieces, filters, and alignment notes",
  );
  expect(preview).toHaveClass("line-clamp-2");
  expect(preview.parentElement).toHaveClass("text-muted-foreground/80");
});
