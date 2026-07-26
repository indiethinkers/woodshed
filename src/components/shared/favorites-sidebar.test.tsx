import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: () => "/databases",
}));

import { FavoritesSidebar } from "./favorites-sidebar";

it("keeps Favorites as a content section without restoring the top title band", () => {
  render(
    <FavoritesSidebar
      items={[
        {
          id: "reading",
          href: "/databases/reading",
          title: "Reading",
        },
      ]}
    />,
  );

  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  expect(
    screen.getByRole("heading", { level: 3, name: "Favorites" }),
  ).toBeTruthy();
  expect(screen.getByText("01")).toBeTruthy();
});
