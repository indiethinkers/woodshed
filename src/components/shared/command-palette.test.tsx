import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/",
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: mocks.pathname } }),
}));

vi.mock("@/lib/hooks/use-areas", () => ({
  useAreas: () => ({ data: [] }),
  useAreaMutations: () => ({ create: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/lib/hooks/use-notes", () => ({
  useNoteMutations: () => ({ create: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/lib/hooks/use-people", () => ({
  usePeopleMutations: () => ({ create: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/lib/hooks/use-resources", () => ({
  useResourceMutations: () => ({ create: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/lib/hooks/use-search", () => ({
  useSearch: () => ({ data: [], isFetching: false }),
}));

vi.mock("@/lib/hooks/use-tables", () => ({
  useTableMutations: () => ({ create: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/lib/hooks/use-tasks", () => ({
  useTaskMutations: () => ({ create: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/lib/hooks/use-today", () => ({
  useToday: () => "2026-07-25",
}));

vi.mock("@/components/layout/tabs-context-internal", () => ({
  useTabs: () => ({ openInNewTab: vi.fn() }),
}));

vi.mock("@/components/layout/right-sidebar-context-internal", () => ({
  useRightSidebar: () => ({ addPage: vi.fn() }),
}));

import { CommandPalette } from "./command-palette";

beforeEach(() => {
  mocks.pathname = "/";
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

describe("CommandPalette typeahead", () => {
  it("does not open from a printable shortcut on a mail detail page", () => {
    mocks.pathname = "/mail/message-1";
    render(<CommandPalette />);

    const event = new KeyboardEvent("keydown", {
      key: "r",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("keeps explicit Command-K access on a mail detail page", () => {
    mocks.pathname = "/mail/message-1";
    render(<CommandPalette />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
  });

  it("keeps typeahead enabled outside mail detail pages", () => {
    mocks.pathname = "/notebook/note-1";
    render(<CommandPalette />);

    fireEvent.keyDown(window, { key: "r" });

    expect(screen.getByRole("textbox")).toHaveValue("r");
  });

  it("does not capture typing from a focused database cell", () => {
    render(
      <>
        <div data-table-cell="">
          <button type="button">Synthetic cell</button>
        </div>
        <CommandPalette />
      </>,
    );

    const cell = screen.getByRole("button", { name: "Synthetic cell" });
    cell.focus();
    fireEvent.keyDown(cell, { key: "r" });

    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
  });
});
