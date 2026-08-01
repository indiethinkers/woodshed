import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createLazyFileRoute:
    () =>
    (options: { component: React.ComponentType }) => ({
      ...options,
    }),
}));

vi.mock("@/components/mail/mail-inbox", () => ({
  MailInbox: () => <div>Classic Inbox</div>,
}));

import { MailIndex } from "./index.lazy";

describe("MailIndex", () => {
  it("renders the inbox", () => {
    render(<MailIndex />);

    expect(screen.getByText("Classic Inbox")).toBeInTheDocument();
  });
});
