import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ListSidebar, ListSidebarPrimaryAction } from "./list-sidebar";

it("renders the shared full-width sidebar create action", () => {
  const onClick = vi.fn();

  render(<ListSidebarPrimaryAction label="New note" onClick={onClick} />);

  const button = screen.getByRole("button", { name: "New note" });
  expect(button.className).toContain("w-full");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});

it("omits the redundant title band when no sidebar title is provided", () => {
  render(
    <ListSidebar>
      <p>Sidebar content</p>
    </ListSidebar>,
  );

  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  expect(
    screen.getByText("Sidebar content").parentElement?.className,
  ).toContain("px-4");
});
