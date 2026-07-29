import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  customLoading: false,
  generatedLoading: false,
}));

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
    isLoading: mocks.customLoading,
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
    data: [
      {
        tag: "generated",
        count: 100,
        created: "2026-01-02T08:00:00Z",
      },
    ],
    isLoading: mocks.generatedLoading,
  }),
}));

import { DatabasesList } from "./databases-list";

beforeEach(() => {
  mocks.customLoading = false;
  mocks.generatedLoading = false;
});

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
    for (const table of [customTable, generatedTable]) {
      const header = table.querySelector("[data-inline-table-header]");
      expect(header).toBeInTheDocument();
      expect(
        header?.querySelector("[data-inline-table-marker]"),
      ).toBeInTheDocument();
      expect(
        header?.querySelector("[data-inline-table-count]"),
      ).toHaveTextContent("1 database");
    }
    expect(
      within(customTable).getByRole("button", { name: "Created" }),
    ).toBeInTheDocument();
    expect(
      within(generatedTable).getByRole("button", { name: "Created" }),
    ).toBeInTheDocument();
    expect(generatedTable).toHaveTextContent("Jan 2, 2026");
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

  it("uses compact loading states for both inline databases", () => {
    mocks.customLoading = true;
    mocks.generatedLoading = true;

    render(<DatabasesList />);

    expect(
      screen
        .getAllByTestId("record-table-skeleton")
        .map((skeleton) => skeleton.getAttribute("data-compact")),
    ).toEqual(["true", "true"]);
  });
});
