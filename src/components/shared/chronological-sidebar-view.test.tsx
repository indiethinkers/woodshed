import { render, screen } from "@testing-library/react";
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
      referenceDate={new Date("2026-07-25T00:00:00")}
    />,
  );

  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  expect(screen.getByRole("button", { name: "New note" })).toBeTruthy();
});
