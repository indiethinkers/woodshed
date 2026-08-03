import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSummary } from "@/lib/mail-lib/types";

const mocks = vi.hoisted(() => ({
  thread: [] as EmailSummary[],
  isLoading: true,
  navigate: vi.fn(),
  markRead: vi.fn(async () => {}),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to?: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/lib/hooks/use-mail", () => ({
  useArchiveOne: () => vi.fn(async () => {}),
  useDeleteOne: () => vi.fn(async () => {}),
  useEmailFull: (id: string) => ({
    data: mocks.thread.find((message) => message.id === id),
  }),
  useInboxes: () => ({ data: [] }),
  useAllMail: () => ({ data: [] }),
  useMarkRead: () => mocks.markRead,
  useThread: () => ({ data: mocks.thread, isLoading: mocks.isLoading }),
}));

vi.mock("@/lib/hooks/use-people", () => ({
  useAllPeople: () => ({ data: [] }),
}));

vi.mock("@/components/shared/backlinks-panel", () => ({
  BacklinksPanel: () => null,
}));

vi.mock("@/components/shared/outgoing-links-panel", () => ({
  OutgoingLinksPanel: () => null,
}));

vi.mock("@/components/mail/html-body", () => ({ HtmlBody: () => null }));
vi.mock("@/components/mail/inline-reply", () => ({ InlineReply: () => null }));
vi.mock("@/components/mail/compose-dialog", () => ({
  ComposeDialog: ({ mode }: { mode: { kind: string; source?: EmailSummary } }) => (
    <div role="dialog" aria-label="Synthetic compose">
      {mode.kind}:{mode.source?.id ?? "new"}
    </div>
  ),
}));

import { EmailDetail } from "./email-detail";

describe("EmailDetail thread", () => {
  beforeEach(() => {
    mocks.thread = [];
    mocks.isLoading = true;
    mocks.navigate.mockReset();
    mocks.markRead.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("opens only the newest message after the complete thread loads", () => {
    const older = email({
      id: "older-message",
      body: "Older full body",
      preview: "Older preview",
      date: "2026-07-28T09:00:00Z",
    });
    const newest = email({
      id: "newest-message",
      body: "Newest full body",
      preview: "Newest preview",
      date: "2026-07-28T10:00:00Z",
    });
    const { rerender } = render(<EmailDetail email={older} />);

    mocks.thread = [older, newest];
    mocks.isLoading = false;
    rerender(<EmailDetail email={older} />);

    expect(screen.queryByText("Older full body")).not.toBeInTheDocument();
    expect(screen.getByText("Newest full body")).toBeInTheDocument();
  });

  it("opens a newly synchronized reply and collapses the previous latest message", () => {
    const original = email({ id: "original-message", body: "Original body" });
    const previousLatest = email({
      id: "previous-latest",
      body: "Previous latest body",
      date: "2026-07-28T10:00:00Z",
    });
    mocks.thread = [original, previousLatest];
    mocks.isLoading = false;
    const { rerender } = render(<EmailDetail email={previousLatest} />);
    expect(screen.getByText("Previous latest body")).toBeInTheDocument();

    const synchronizedReply = email({
      id: "synchronized-reply",
      body: "Synchronized reply body",
      date: "2026-07-28T11:00:00Z",
    });
    mocks.thread = [original, previousLatest, synchronizedReply];
    rerender(<EmailDetail email={previousLatest} />);

    expect(screen.queryByText("Previous latest body")).not.toBeInTheDocument();
    expect(screen.getByText("Synchronized reply body")).toBeInTheDocument();
  });

  it("offers Reply All for the thread and reply controls on the expanded message", () => {
    const older = email({ id: "older-message" });
    const newest = email({
      id: "newest-message",
      body: "Newest full body",
      date: "2026-07-28T10:00:00Z",
    });
    mocks.thread = [older, newest];
    mocks.isLoading = false;

    render(<EmailDetail email={newest} />);

    const replyAllButtons = screen.getAllByRole("button", {
      name: "Reply all",
    });
    expect(replyAllButtons).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Reply" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Forward" })).toHaveLength(2);

    fireEvent.click(replyAllButtons[1]);
    expect(
      screen.getByRole("dialog", { name: "Synthetic compose" }),
    ).toHaveTextContent("replyAll:newest-message");
  });
});

function email(overrides: Partial<EmailSummary>): EmailSummary {
  return {
    id: "message-1",
    messageId: "message-1@example.test",
    threadId: "synthetic-thread",
    from: "Synthetic Sender",
    fromEmail: "sender@example.test",
    to: ["reader@example.test"],
    cc: [],
    subject: "Synthetic discussion",
    body: "Synthetic full body",
    html: null,
    preview: "Synthetic preview",
    date: "2026-07-28T09:00:00Z",
    read: true,
    labels: ["inbox", "read"],
    mentions: [],
    links: [],
    inbox: "gmail:reader@example.test",
    path: "inbox/message.md",
    attachments: [],
    ...overrides,
  };
}
