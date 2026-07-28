import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params: _params, ...props }: React.ComponentProps<"a"> & {
    to?: string;
    params?: unknown;
  }) => <a {...props} href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/hooks/use-tables", () => ({
  useAllTables: () => ({
    data: [
      {
        id: "custom-table",
        name: "Custom database",
        created: "2026-07-28",
        favorite: false,
        rowCount: 1,
      },
    ],
    isLoading: false,
  }),
  useDatabaseFavoriteMutations: () => ({
    setTableFavorite: { mutate: vi.fn() },
    setTagFavorite: { mutate: vi.fn() },
  }),
  useDatabaseTagFavorites: () => ({ data: [] }),
  useTableMutations: () => ({ create: { isPending: false, mutateAsync: vi.fn() } }),
}));
vi.mock("@/lib/hooks/use-tag-table", () => ({
  useTagsWithCounts: () => ({
    data: [{ tag: "generated", count: 100 }],
    isLoading: false,
  }),
}));

import { DatabasesList } from "./databases-list";

describe("DatabasesList", () => {
  it("renders visible Custom and Generated groups and omits row page icons", () => {
    render(<DatabasesList />);

    const customGroup = screen
      .getByRole("heading", { name: "Custom" })
      .closest("[data-record-group]")!;
    const generatedGroup = screen
      .getByRole("heading", { name: "Generated" })
      .closest("[data-record-group]")!;
    const custom = screen.getByRole("link", { name: "Custom database" });
    const generated = screen.getByRole("link", { name: "#generated" });
    expect(
      customGroup.compareDocumentPosition(generatedGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(customGroup).toHaveTextContent("Custom");
    expect(customGroup).toHaveTextContent("1 database");
    expect(generatedGroup).toHaveTextContent("Generated");
    expect(generatedGroup).toHaveTextContent("1 database");
    expect(customGroup.compareDocumentPosition(custom)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(generatedGroup.compareDocumentPosition(generated)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(custom).queryByRole("img", { hidden: true })).toBeNull();
    expect(custom.querySelector("svg")).toBeNull();
    expect(generated.querySelector("svg")).toBeNull();
  });
});
