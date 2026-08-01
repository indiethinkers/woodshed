import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TableDto } from "@/lib/hooks/use-tables";

const mocks = vi.hoisted(() => ({
  updateTable: vi.fn(),
}));

const table: TableDto = {
  id: "synthetic-table",
  path: "tables/synthetic-table/_schema.md",
  name: "Synthetic table",
  created: "2026-07-31T00:00:00Z",
  favorite: false,
  columns: [{ id: "name", name: "Name", type: "text", width: 240 }],
  views: [
    {
      id: "table-view",
      name: "Table",
      type: "table",
      filters: { op: "and", conditions: [] },
      sorts: [],
    },
  ],
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/components/shared/file-path-pill", () => ({
  FilePathLine: () => null,
}));

vi.mock("./view-controls", () => ({
  ViewTabs: () => null,
  FilterControl: () => null,
  SortControl: () => null,
}));

vi.mock("@/lib/hooks/use-tables", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/hooks/use-tables")>();
  return {
    ...original,
    useTable: () => ({ data: table, isLoading: false }),
    useTableRows: () => ({ data: [], isLoading: false }),
    useTableMutations: () => ({
      update: { mutate: mocks.updateTable },
      remove: { mutate: vi.fn() },
    }),
    useRowMutations: () => ({
      create: { mutate: vi.fn(), mutateAsync: vi.fn() },
      update: { mutate: vi.fn(), mutateAsync: vi.fn() },
      remove: { mutate: vi.fn(), mutateAsync: vi.fn() },
      reorder: { mutate: vi.fn() },
    }),
  };
});

import { TableView } from "./table-view";

describe("table column resizing", () => {
  beforeEach(() => {
    mocks.updateTable.mockReset();
  });

  it("updates the live width and persists it when the drag ends", async () => {
    render(<TableView tableId={table.id} />);

    const handle = screen.getByRole("separator", { name: "Resize column" });
    expect(handle).toHaveClass("w-3");
    expect(handle).toHaveAttribute("title", "Drag to resize column");
    fireEvent.mouseDown(handle, { clientX: 240 });
    fireEvent.mouseMove(document, { clientX: 300 });
    fireEvent.mouseUp(document, { clientX: 300 });

    await waitFor(() => {
      expect(mocks.updateTable).toHaveBeenCalledWith(
        expect.objectContaining({
          id: table.id,
          update: expect.objectContaining({
            columns: [expect.objectContaining({ id: "name", width: 300 })],
          }),
        }),
      );
    });
  });
});
