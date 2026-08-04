import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  graph: { data: undefined as typeof SNAPSHOT | undefined, isLoading: true },
}));

// Freeze the d3-force internal timer before graph-view imports d3-force:
// d3-timer captures requestAnimationFrame at module load, and a ticking
// simulation would re-render (setFrame) outside act() for the whole test.
vi.hoisted(() => {
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.ComponentProps<"a"> & { to?: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));

// Stub the data hook instead of the Tauri layer — same pattern as
// databases-list.test.tsx — so the test renders a fixed snapshot
// synchronously, with no QueryClient provider needed.
vi.mock("@/lib/hooks/use-graph", () => ({
  useGraph: () => mocks.graph,
}));

const SNAPSHOT = {
  nodes: [
    {
      id: "notebook/alpha.md",
      label: "Alpha",
      kind: "note",
      href: "/notebook/alpha",
      area: "product",
    },
    {
      id: "people/beta.md",
      label: "Beta Person",
      kind: "person",
      href: "/people/beta",
    },
    {
      id: "unresolved:Gamma",
      label: "Gamma",
      kind: "unresolved",
    },
  ],
  edges: [
    { source: "notebook/alpha.md", target: "people/beta.md" },
    { source: "notebook/alpha.md", target: "unresolved:Gamma" },
  ],
};

import { GraphView } from "./graph-view";

describe("GraphView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.graph = { data: SNAPSHOT, isLoading: false };
  });

  it("renders the vault as a canvas with counts and a legend", () => {
    render(<GraphView />);
    expect(
      screen.getByRole("img", { name: "Vault wikilink graph" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/3 records · 2 links · 1 unresolved/)).toBeInTheDocument();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("Person")).toBeInTheDocument();
    expect(screen.getByText("Unresolved link")).toBeInTheDocument();
  });

  it("shows record details and an Open link on hover", () => {
    const { container } = render(<GraphView />);
    const alpha = container.querySelector('[data-node-id="notebook/alpha.md"]');
    expect(alpha).not.toBeNull();
    fireEvent.pointerEnter(alpha!);
    // Both the hover card and the counts chip contain "2 links".
    expect(screen.getAllByText(/2 links/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Open record")).toHaveAttribute("href", "/notebook/alpha");
    // The hovered node's label renders next to its circle.
    expect(screen.getAllByText("Alpha").length).toBeGreaterThanOrEqual(2);
  });

  it("navigates to the record when a node is clicked", () => {
    const { container } = render(<GraphView />);
    const alpha = container.querySelector('[data-node-id="notebook/alpha.md"]');
    expect(alpha).not.toBeNull();
    fireEvent.click(alpha!);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/notebook/alpha" });
  });

  it("does not navigate for unresolved placeholder nodes", () => {
    const { container } = render(<GraphView />);
    const gamma = container.querySelector('[data-node-id="unresolved:Gamma"]');
    expect(gamma).not.toBeNull();
    fireEvent.click(gamma!);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("isolates a record type when its filter label is selected", () => {
    const { container } = render(<GraphView />);
    const personFilter = screen.getByRole("button", { name: "Person" });
    const allFilter = screen.getByRole("button", { name: "All" });
    expect(allFilter).toHaveAttribute("aria-pressed", "true");
    expect(personFilter).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(personFilter);

    expect(personFilter).toHaveAttribute("aria-pressed", "true");
    expect(allFilter).toHaveAttribute("aria-pressed", "false");
    // Only the person node remains; notes and the ghost are filtered out.
    expect(container.querySelector('[data-node-id="people/beta.md"]')).not.toBeNull();
    expect(container.querySelector('[data-node-id="notebook/alpha.md"]')).toBeNull();
    expect(container.querySelector('[data-node-id="unresolved:Gamma"]')).toBeNull();
    expect(screen.getByText(/1 of 3 records · 0 links/)).toBeInTheDocument();

    // Clicking the active filter again returns to All.
    fireEvent.click(personFilter);
    expect(allFilter).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector('[data-node-id="notebook/alpha.md"]')).not.toBeNull();
    expect(screen.getByText(/3 records · 2 links/)).toBeInTheDocument();
  });

  it("enables wheel zoom after the asynchronous graph load completes", () => {
    mocks.graph = { data: undefined, isLoading: true };
    const { rerender } = render(<GraphView />);

    mocks.graph = { data: SNAPSHOT, isLoading: false };
    rerender(<GraphView />);

    const svg = screen.getByRole("img", { name: "Vault wikilink graph" });
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      toJSON: () => ({}),
    });
    const canvas = svg.querySelector("g");
    expect(canvas).toHaveAttribute("transform", "translate(0 0) scale(1)");

    fireEvent.wheel(svg, { clientX: 500, clientY: 350, deltaY: -120 });

    expect(canvas).not.toHaveAttribute("transform", "translate(0 0) scale(1)");
  });

  it("offers accessible zoom controls", () => {
    const { container } = render(<GraphView />);
    const canvas = container.querySelector("svg g");

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(canvas).not.toHaveAttribute("transform", "translate(0 0) scale(1)");

    fireEvent.click(screen.getByRole("button", { name: "Reset graph view" }));
    expect(canvas).toHaveAttribute("transform", "translate(0 0) scale(1)");
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
  });
});
