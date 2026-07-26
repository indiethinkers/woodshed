import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: {} as { mode?: string },
}));

vi.mock("@tanstack/react-router", () => ({
  createLazyFileRoute:
    () =>
    (options: { component: React.ComponentType }) => ({
      ...options,
      useSearch: () => mocks.search,
    }),
}));

vi.mock("@/components/mail/mail-inbox", () => ({
  MailInbox: () => <div>Classic Inbox</div>,
}));

vi.mock("@/components/mail/mail-surface", () => ({
  MailSurface: () => <div>AI Sweep workspace</div>,
}));

import { MailIndex } from "./index.lazy";

beforeEach(() => {
  mocks.search = {};
});

describe("MailIndex", () => {
  it("renders the classic inbox by default", () => {
    render(<MailIndex />);

    expect(screen.getByText("Classic Inbox")).toBeInTheDocument();
    expect(screen.queryByText("AI Sweep workspace")).not.toBeInTheDocument();
  });

  it("renders AI Sweep only for the explicit sweep mode", async () => {
    mocks.search = { mode: "sweep" };

    render(<MailIndex />);

    expect(await screen.findByText("AI Sweep workspace")).toBeInTheDocument();
    expect(screen.queryByText("Classic Inbox")).not.toBeInTheDocument();
  });
});
