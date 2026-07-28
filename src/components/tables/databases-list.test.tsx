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
  it("groups custom databases first and omits row page icons", () => {
    render(<DatabasesList />);

    const custom = screen.getByRole("link", { name: "Custom database" });
    const generated = screen.getByRole("link", { name: "#generated" });
    expect(
      custom.compareDocumentPosition(generated) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(custom).queryByRole("img", { hidden: true })).toBeNull();
    expect(custom.querySelector("svg")).toBeNull();
    expect(generated.querySelector("svg")).toBeNull();
  });
});
