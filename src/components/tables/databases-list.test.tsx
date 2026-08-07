import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  customLoading: false,
  generatedLoading: false,
  customError: false,
  generatedError: false,
  refetchCustom: vi.fn(),
  refetchGenerated: vi.fn(),
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
    data: mocks.customError
      ? undefined
      : [
          {
            id: "custom-table",
            name: "Custom database",
            created: "2026-07-28",
            favorite: false,
            rowCount: 1,
          },
        ],
    isLoading: mocks.customLoading,
    isError: mocks.customError,
    refetch: mocks.refetchCustom,
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
    data: mocks.generatedError
      ? undefined
      : [
          {
            tag: "generated",
            count: 100,
            created: "2026-01-02T08:00:00Z",
          },
        ],
    isLoading: mocks.generatedLoading,
    isError: mocks.generatedError,
    refetch: mocks.refetchGenerated,
  }),
}));

import { DatabasesList } from "./databases-list";

beforeEach(() => {
  mocks.customLoading = false;
  mocks.generatedLoading = false;
  mocks.customError = false;
  mocks.generatedError = false;
  mocks.refetchCustom.mockClear();
  mocks.refetchGenerated.mockClear();
  window.localStorage.clear();
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

  it("resizes and persists each inline database independently", () => {
    const view = render(<DatabasesList />);

    const customTable = screen
      .getByRole("heading", { name: "Custom" })
      .closest<HTMLElement>('[data-record-table-variant="inline"]')!;
    const generatedTable = screen
      .getByRole("heading", { name: "Generated" })
      .closest<HTMLElement>('[data-record-table-variant="inline"]')!;
    const customGrid = customTable.querySelector<HTMLElement>(
      "[data-record-table-grid]",
    )!;
    const generatedGrid = generatedTable.querySelector<HTMLElement>(
      "[data-record-table-grid]",
    )!;
    const resizeName = within(customTable).getByRole("separator", {
      name: "Resize Name column",
    });

    expect(resizeName).toHaveClass("w-3");
    expect(customGrid.style.getPropertyValue("--col-name-size")).toBe(
      "480px",
    );
    expect(generatedGrid.style.getPropertyValue("--col-name-size")).toBe(
      "480px",
    );

    fireEvent.pointerDown(resizeName, {
      button: 0,
      clientX: 480,
      pointerId: 1,
    });
    fireEvent.pointerMove(resizeName, { clientX: 540, pointerId: 1 });
    fireEvent.pointerUp(resizeName, { clientX: 540, pointerId: 1 });

    expect(customGrid.style.getPropertyValue("--col-name-size")).toBe(
      "540px",
    );
    expect(generatedGrid.style.getPropertyValue("--col-name-size")).toBe(
      "480px",
    );
    expect(
      window.localStorage.getItem(
        "woodshed:record-table:column-widths:databases-custom",
      ),
    ).toBe('{"name":540}');
    expect(
      window.localStorage.getItem(
        "woodshed:record-table:column-widths:databases-generated",
      ),
    ).toBeNull();

    view.unmount();
    render(<DatabasesList />);
    const restoredCustomTable = screen
      .getByRole("heading", { name: "Custom" })
      .closest<HTMLElement>('[data-record-table-variant="inline"]')!;
    expect(
      restoredCustomTable
        .querySelector<HTMLElement>("[data-record-table-grid]")!
        .style.getPropertyValue("--col-name-size"),
    ).toBe("540px");
  });

  it("supports keyboard resizing with coarse steps and a minimum width", () => {
    render(<DatabasesList />);

    const customTable = screen
      .getByRole("heading", { name: "Custom" })
      .closest<HTMLElement>('[data-record-table-variant="inline"]')!;
    const customGrid = customTable.querySelector<HTMLElement>(
      "[data-record-table-grid]",
    )!;
    const resizeCreated = within(customTable).getByRole("separator", {
      name: "Resize Created column",
    });

    fireEvent.keyDown(resizeCreated, { key: "ArrowLeft" });
    expect(resizeCreated).toHaveAttribute("aria-valuenow", "180");
    fireEvent.keyDown(resizeCreated, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(resizeCreated, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(resizeCreated, { key: "ArrowLeft", shiftKey: true });
    expect(resizeCreated).toHaveAttribute("aria-valuenow", "80");

    fireEvent.keyDown(resizeCreated, { key: "ArrowLeft", shiftKey: true });
    expect(resizeCreated).toHaveAttribute("aria-valuenow", "80");
    fireEvent.keyDown(resizeCreated, { key: "ArrowRight", shiftKey: true });

    expect(resizeCreated).toHaveAttribute("aria-valuenow", "120");
    expect(customGrid.style.getPropertyValue("--col-created-size")).toBe(
      "120px",
    );
    expect(
      window.localStorage.getItem(
        "woodshed:record-table:column-widths:databases-custom",
      ),
    ).toBe('{"created":120}');
  });

  it("shows retry when custom databases fail to load", () => {
    mocks.customError = true;

    render(<DatabasesList />);

    expect(
      screen.getByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Couldn't load your custom databases/i),
    ).toBeInTheDocument();
  });
});
