import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasUnreadMail: false,
  pathname: "/",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, viewTransition: _viewTransition, ...props }: React.ComponentProps<"a"> & { to: string; viewTransition?: boolean }) => (
    <a href={to} {...props} />
  ),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: mocks.pathname } }),
}));

vi.mock("@/lib/hooks/use-mail", () => ({
  useHasUnreadMail: () => mocks.hasUnreadMail,
}));

vi.mock("./tabs-context-internal", () => ({
  useTabs: () => ({ cycleTab: vi.fn(), goBack: vi.fn(), goForward: vi.fn() }),
}));

vi.mock("./indexing-indicator", () => ({
  IndexingIndicator: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactElement;
  }) => React.cloneElement(render, undefined, children),
  TooltipContent: () => null,
}));

import { Sidebar } from "./sidebar";

describe("Sidebar unread mail state", () => {
  beforeEach(() => {
    mocks.hasUnreadMail = false;
    mocks.pathname = "/";
  });

  it("renders the Mail navigation icon blue while unread mail exists", () => {
    mocks.hasUnreadMail = true;
    render(<Sidebar mailReady />);

    const mailLink = screen.getByRole("link", {
      name: "Mail, unread messages",
    });
    expect(mailLink).toHaveAttribute("data-unread", "true");
    expect(mailLink).toHaveClass("text-blue-500");
    expect(mailLink.querySelector("[data-unread-indicator]")).toBeInTheDocument();
  });

  it("keeps unread Mail blue while Mail is the active route", () => {
    mocks.hasUnreadMail = true;
    mocks.pathname = "/mail";
    render(<Sidebar mailReady />);

    const mailLink = screen.getByRole("link", {
      name: "Mail, unread messages",
    });
    expect(mailLink).toHaveClass("bg-muted-foreground/15", "text-blue-500");
    expect(mailLink).not.toHaveClass("text-foreground");
  });

  it("returns the Mail navigation icon to neutral when all mail is read", () => {
    render(<Sidebar mailReady />);

    const mailLink = screen.getByRole("link", { name: "Mail" });
    expect(mailLink).not.toHaveAttribute("data-unread");
    expect(mailLink).not.toHaveClass("text-blue-500");
  });
});
