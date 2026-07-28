import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSummary } from "@/lib/mail-lib/types";

const mocks = vi.hoisted(() => ({
  emails: [] as EmailSummary[],
  archiveOne: vi.fn(),
  markRead: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    to: _to,
    ...props
  }: React.ComponentProps<"a"> & {
    children: ReactNode;
    params?: { id?: string };
    to?: string;
  }) => (
    <a {...props} href={params?.id ? `/mail/${params.id}` : "#"}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/components/layout/list-panel-context-internal", () => ({
  useListPanel: () => ({ collapsed: false }),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/hooks/use-mail", () => ({
  useArchiveOne: () => mocks.archiveOne,
  useInboxes: () => ({
    data: [
      {
        inboxId: "gmail:mail@example.com",
        email: "mail@example.com",
        displayName: "Mail",
        createdAt: "2026-07-21T10:00:00-07:00",
      },
    ],
    isLoading: false,
  }),
  useMail: () => ({ data: mocks.emails, isLoading: false }),
  useMarkRead: () => mocks.markRead,
  useRefreshMail: () => vi.fn(),
}));

vi.mock("@/lib/hooks/use-people", () => ({
  useAllPeople: () => ({ data: [] }),
}));

vi.mock("@/lib/tauri", () => ({
  tauriInvoke: vi.fn(),
}));

import { MailInbox } from "./mail-inbox";

beforeEach(() => {
  mocks.emails = [];
  mocks.archiveOne.mockReset();
  mocks.markRead.mockReset();
  mocks.markRead.mockResolvedValue(undefined);
  mocks.navigate.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("MailInbox", () => {
  it("renders the mode switch in the Mail sidebar", () => {
    const { container } = render(<MailInbox />);

    const sidebar = container.querySelector(
      '[data-woodshed-surface="mail-detail-list"]',
    );
    const modeSwitch = screen.getByRole("group", { name: "Mail view" });

    expect(sidebar).toContainElement(modeSwitch);
    expect(
      screen.queryByRole("button", { name: "Archive all" }),
    ).not.toBeInTheDocument();
  });

  it("renders one inbox row for messages in the same thread", () => {
    mocks.emails = [
      email({ id: "message-2", date: "2026-07-24T09:00:00-07:00" }),
      email({ id: "message-1", date: "2026-07-23T09:00:00-07:00" }),
    ];

    const { container } = render(<MailInbox />);

    expect(container.querySelectorAll("[data-mail-thread-row]")).toHaveLength(
      1,
    );
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders each email thread as a single-click route link", () => {
    mocks.emails = [email({ id: "message-1" })];
    const { container } = render(<MailInbox />);

    const row = container.querySelector("[data-mail-thread-row]")!;
    expect(row).toHaveAttribute("href", "/mail/message-1");
  });

  it("marks every unread message in a thread when its row is opened", async () => {
    mocks.emails = [
      email({
        id: "message-2",
        date: "2026-07-24T09:00:00-07:00",
        read: false,
        labels: ["inbox", "unread"],
      }),
      email({
        id: "message-1",
        date: "2026-07-23T09:00:00-07:00",
        read: false,
        labels: ["inbox", "unread"],
      }),
    ];
    const { container } = render(<MailInbox />);

    fireEvent.click(container.querySelector("[data-mail-thread-row]")!);

    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledTimes(2));
    expect(mocks.markRead).toHaveBeenCalledWith("message-1");
    expect(mocks.markRead).toHaveBeenCalledWith("message-2");
  });

  it("archives every inbox message represented by a thread row", async () => {
    mocks.emails = [
      email({ id: "message-2", date: "2026-07-24T09:00:00-07:00" }),
      email({ id: "message-1", date: "2026-07-23T09:00:00-07:00" }),
    ];
    render(<MailInbox />);

    fireEvent.keyDown(window, { key: "e" });

    await waitFor(() => {
      expect(mocks.archiveOne).toHaveBeenCalledTimes(2);
    });
    expect(mocks.archiveOne).toHaveBeenCalledWith("message-1");
    expect(mocks.archiveOne).toHaveBeenCalledWith("message-2");
  });
});

function email(overrides: Partial<EmailSummary>): EmailSummary {
  return {
    id: "message-1",
    threadId: "project-update-thread",
    from: "Avery Example",
    fromEmail: "avery@example.com",
    subject: "Project update",
    body: "Sounds good",
    html: null,
    preview: "Sounds good",
    date: "2026-07-23T09:00:00-07:00",
    read: true,
    labels: ["inbox", "read"],
    mentions: [],
    links: [],
    inbox: "gmail:mail@example.com",
    path: "",
    attachments: [],
    ...overrides,
  };
}
