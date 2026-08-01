import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ColumnDto } from "@/lib/hooks/use-tables";
import { Cell } from "./cell";

const textColumn: ColumnDto = {
  id: "name",
  name: "Name",
  type: "text",
};
const numberColumn: ColumnDto = {
  id: "estimate",
  name: "Estimate",
  type: "number",
};
const dateColumn: ColumnDto = {
  id: "due",
  name: "Due",
  type: "date",
};
const option = { id: "planned", name: "Planned", color: "gray" } as const;

describe("Cell keyboard editing", () => {
  it("replaces a focused text cell with the first printable key", () => {
    const onCommit = vi.fn();
    render(<Cell column={textColumn} value="Old value" onCommit={onCommit} />);

    const cell = screen.getByRole("button");
    cell.focus();
    fireEvent.keyDown(cell, { key: "N" });

    const input = screen.getByRole("textbox");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("N");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not turn navigation or modified shortcuts into cell content", () => {
    render(<Cell column={textColumn} value="Old value" onCommit={vi.fn()} />);

    const cell = screen.getByRole("button");
    fireEvent.keyDown(cell, { key: "Tab" });
    fireEvent.keyDown(cell, { key: "k", metaKey: true });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("starts number editing with the first valid numeric key", () => {
    render(<Cell column={numberColumn} value={42} onCommit={vi.fn()} />);

    const cell = screen.getByRole("button");
    cell.focus();
    fireEvent.keyDown(cell, { key: "7" });

    expect(screen.getByRole("spinbutton")).toHaveFocus();
    expect(screen.getByRole("spinbutton")).toHaveValue(7);
  });

  it("focuses the date editor when a date digit is typed", () => {
    const { container } = render(
      <Cell column={dateColumn} value="2026-08-01" onCommit={vi.fn()} />,
    );

    fireEvent.keyDown(screen.getByRole("button"), { key: "2" });

    expect(container.querySelector("input[type='date']")).toHaveFocus();
  });

  it.each([
    { type: "select" as const, value: "" },
    { type: "multi_select" as const, value: [] },
  ])("seeds the $type search with the first printable key", ({ type, value }) => {
    const column: ColumnDto = {
      id: type,
      name: "Status",
      type,
      options: [option],
    };
    render(<Cell column={column} value={value} onCommit={vi.fn()} />);

    fireEvent.keyDown(screen.getByRole("button"), { key: "P" });

    const search = screen.getByPlaceholderText("Search or create…");
    expect(search).toHaveFocus();
    expect(search).toHaveValue("P");
  });
});
