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

import { AreasList, formatRecordBreakdown } from "./areas-list";

describe("AreasList", () => {
  it("pins Unassigned below named areas", () => {
    render(<AreasList />);

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Alpha", "Zulu", "Unassigned"]);
  });

  // Area colour belongs to the attention graph, which reads as a single
  // chart. Repeating it down the table turned every row into its own accent
  // and made the page noisy, so the table stays monochrome.
  it("renders the table without per-area colour", () => {
    const { container } = render(<AreasList />);

    const tinted = Array.from(container.querySelectorAll<HTMLElement>("[style]")).filter(
      (element) => element.style.background || element.style.backgroundColor,
    );
    expect(tinted).toEqual([]);
  });

  it("names each record type instead of using unexplained suffixes", () => {
    render(<AreasList />);

    expect(screen.getByText("Record types")).toBeInTheDocument();
    expect(
      formatRecordBreakdown({ event: 2, task: 1, note: 3, person: 4 }),
    ).toBe("2 events · 1 task · 3 notes · 4 people");
  });
});
