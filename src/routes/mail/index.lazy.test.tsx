import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createLazyFileRoute:
    () =>
    (options: { component: React.ComponentType }) => ({
      ...options,
      useSearch: () => ({}),
    }),
}));

vi.mock("@/components/mail/mail-inbox", () => ({
  MailInbox: ({ mailbox }: { mailbox: string }) => (
    <div>Classic Inbox: {mailbox}</div>
  ),
}));

import { MailIndex } from "./index.lazy";

describe("MailIndex", () => {
  it("renders the inbox", () => {
    render(<MailIndex />);

    expect(screen.getByText("Classic Inbox: inbox")).toBeInTheDocument();
  });
});
