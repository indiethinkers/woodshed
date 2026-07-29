import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/hooks/use-areas", () => ({
  useAreas: () => ({
    data: [
      { id: "zulu", name: "Zulu", color: "#335577" },
      { id: "alpha", name: "Alpha", color: "#773355" },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/lib/hooks/use-notes", () => ({ useAllNotes: () => ({ data: [] }) }));
vi.mock("@/lib/hooks/use-people", () => ({ useAllPeople: () => ({ data: [] }) }));
vi.mock("@/lib/hooks/use-tasks", () => ({ useAllTasks: () => ({ data: [] }) }));
vi.mock("@/lib/hooks/use-tag-table", () => ({ useTagTable: () => ({ data: [] }) }));
vi.mock("@/lib/hooks/use-today", () => ({ useToday: () => "2026-07-28" }));

import { AreasList } from "./areas-list";

describe("AreasList", () => {
  it("pins Unassigned below named areas", () => {
    render(<AreasList />);

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Alpha", "Zulu", "Unassigned"]);
  });
});
