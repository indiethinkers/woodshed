import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock TanStack Router's useNavigate so the page renders in jsdom
// without a RouterProvider. createFileRoute is also pulled in but only
// for its module-level side effect (registering the Route on import);
// we replace it with a noop here.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  createFileRoute: () => () => ({}),
}));

// Mock the tauri layer so the page works without a Tauri runtime.
vi.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  tauriInvoke: vi.fn(async () => null),
}));

// The page must be imported AFTER mocks are set up.
import { WelcomePage } from "./welcome";

describe("WelcomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Step 1 with the headline and step indicator", () => {
    render(<WelcomePage />);
    expect(screen.getByText("Bring your files into Woodshed")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Vault location")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Open Markdown folder/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByText(/Seed with sample content/)).not.toBeInTheDocument();
  });

  it("offers sample content only for a new vault", () => {
    render(<WelcomePage />);
    fireEvent.click(screen.getByRole("radio", { name: /Create new vault/ }));
    expect(screen.getByText(/Seed with sample content/)).toBeInTheDocument();
  });

  it("blocks Continue when path is empty", () => {
    render(<WelcomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Pick a folder/);
    expect(screen.queryByText("Tell us your name")).not.toBeInTheDocument();
  });

  it("advances to Step 2 when path is set", () => {
    render(<WelcomePage />);
    const input = screen.getByLabelText("Vault location") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/Users/me/woodshed" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Tell us your name")).toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });
});
