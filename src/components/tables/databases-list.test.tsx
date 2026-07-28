import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params: _params,
    ...props
  }: React.ComponentProps<"a"> & {
    to?: string;
    params?: unknown;
  }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
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
  useTableMutations: () => ({
    create: { isPending: false, mutateAsync: vi.fn() },
  }),
}));
vi.mock("@/lib/hooks/use-tag-table", () => ({
  useTagsWithCounts: () => ({
    data: [{ tag: "generated", count: 100 }],
    isLoading: false,
  }),
}));

import { DatabasesList } from "./databases-list";

describe("DatabasesList", () => {
  it("renders Custom and Generated as separate inline databases", () => {
    render(<DatabasesList />);

    const customTable = screen
      .getByRole("heading", { name: "Custom" })
      .closest<HTMLElement>('[data-record-table-variant="inline"]')!;
    const generatedTable = screen
      .getByRole("heading", { name: "Generated" })
      .closest<HTMLElement>('[data-record-table-variant="inline"]')!;
    const custom = screen.getByRole("link", { name: "Custom database" });
    const generated = screen.getByRole("link", { name: "#generated" });
    expect(
      customTable.compareDocumentPosition(generatedTable) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(customTable).toContainElement(custom);
    expect(customTable).not.toContainElement(generated);
    expect(generatedTable).toContainElement(generated);
    expect(generatedTable).not.toContainElement(custom);
    expect(customTable).toHaveTextContent("1 database");
    expect(generatedTable).toHaveTextContent("1 database");
    expect(
      within(customTable).getByRole("button", { name: "Created" }),
    ).toBeInTheDocument();
    expect(
      within(generatedTable).queryByRole("button", { name: "Created" }),
    ).toBeNull();
    expect(
      within(customTable).getByRole("button", { name: "New database" }),
    ).toBeInTheDocument();
    expect(
      within(generatedTable).queryByRole("button", { name: "New database" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Kind$/ }),
    ).not.toBeInTheDocument();
    expect(within(custom).queryByRole("img", { hidden: true })).toBeNull();
    expect(custom.querySelector("svg")).toBeNull();
    expect(generated.querySelector("svg")).toBeNull();
  });
});
