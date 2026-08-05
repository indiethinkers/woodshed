import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftDto, EmailSummary } from "@/lib/mail-lib/types";

const mocks = vi.hoisted(() => ({
  emails: [] as EmailSummary[],
  drafts: [] as DraftDto[],
  folderQuery: vi.fn(),
  archiveOne: vi.fn(),
  markRead: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    search,
    to: _to,
    ...props
  }: React.ComponentProps<"a"> & {
    children: ReactNode;
    params?: { id?: string };
    search?: { mailbox?: string };
    to?: string;
  }) => (
    <a
      {...props}
      href={
        params?.id
          ? `/mail/${params.id}${search?.mailbox ? `?mailbox=${search.mailbox}` : ""}`
          : "#"
      }
    >
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/components/layout/list-panel-context-internal", () => ({
  useListPanel: () => ({ collapsed: false }),
}));

// Stand-in for Base UI's ScrollArea. It keeps `className` and the slot
// marker so layout assertions still see the real classes — the height-cap
// classes are the whole reason the list can scroll.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => (
    <div data-slot="scroll-area" className={className}>
      {children}
    </div>
  ),
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
  useMailFolder: (folder: string, query: string) => {
    mocks.folderQuery(folder, query);
    return { data: mocks.emails, isLoading: false };
  },
  useDrafts: () => ({ data: mocks.drafts, isLoading: false }),
  useMarkRead: () => mocks.markRead,
  useRefreshMail: () => vi.fn(),
  useSnoozeOne: () => vi.fn(async () => {}),
}));

vi.mock("@/components/mail/compose-dialog", () => ({
  ComposeDialog: ({ draft }: { draft?: DraftDto }) => (
    <div role="dialog" aria-label="Synthetic compose">
      {draft?.subject ?? "New message"}
    </div>
  ),
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
  mocks.drafts = [];
  mocks.folderQuery.mockReset();
  mocks.archiveOne.mockReset();
  mocks.markRead.mockReset();
  mocks.markRead.mockResolvedValue(undefined);
  mocks.navigate.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("MailInbox", () => {
  it("renders the complete mail folders in the existing Mail surface", () => {
    const { container } = render(<MailInbox />);

    const sidebar = container.querySelector(
      '[data-woodshed-surface="mail-detail-list"]',
    );

    expect(sidebar).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Mail folders" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drafts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archive all" }),
    ).not.toBeInTheDocument();
  });

  it("queries the selected folder and search text", async () => {
    render(<MailInbox />);

    fireEvent.click(screen.getByRole("button", { name: "Sent" }));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search mail" }), {
      target: { value: "synthetic update" },
    });

    await waitFor(() =>
      expect(mocks.folderQuery).toHaveBeenLastCalledWith(
        "sent",
        "synthetic update",
      ),
    );
  });

  it("shows recipients instead of the sender in Sent", () => {
    mocks.emails = [
      email({
        labels: ["sent", "read"],
        to: ["recipient@example.test"],
      }),
    ];
    const { container } = render(<MailInbox />);

    fireEvent.click(screen.getByRole("button", { name: "Sent" }));

    const row = container.querySelector("[data-mail-thread-row]");
    expect(row).toHaveTextContent("recipient@example.test");
    expect(row).not.toHaveTextContent("Avery Example");
  });

  it("reopens a saved draft from the Drafts folder", () => {
    mocks.drafts = [draft()];
    render(<MailInbox />);

    fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
    fireEvent.click(screen.getByText("Synthetic draft"));

    expect(
      screen.getByRole("dialog", { name: "Synthetic compose" }),
    ).toHaveTextContent("Synthetic draft");
  });

  // A flex item defaults to `min-height: auto`, so without `min-h-0` the
  // scroll container grows to the full height of the message list, nothing
  // ever overflows, and every row past the fold is clipped by the shell's
  // `overflow-hidden` with no way to reach it.
  it("keeps the message list in a height-capped scroll container", () => {
    mocks.emails = [email({ id: "message-1" })];
    const { container } = render(<MailInbox />);

    const scroller = container.querySelector('[data-slot="scroll-area"]')!;
    expect(scroller.className).toContain("min-h-0");
    for (
      let node = scroller.parentElement;
      node && node !== container;
      node = node.parentElement
    ) {
      expect(node.className).toContain("min-h-0");
    }
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

  it("preserves the selected mailbox when opening a message", () => {
    mocks.emails = [email({ id: "message-1", labels: ["sent", "read"] })];
    const { container } = render(<MailInbox mailbox="sent" />);

    const row = container.querySelector("[data-mail-thread-row]")!;
    expect(row).toHaveAttribute("href", "/mail/message-1?mailbox=sent");
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

  it("keeps a locally viewed message clear while retrying provider read sync", async () => {
    mocks.emails = [
      email({
        read: false,
        viewed: true,
        labels: ["inbox", "unread"],
      }),
    ];
    const { container } = render(<MailInbox />);
    const row = container.querySelector("[data-mail-thread-row]")!;

    expect(screen.queryByLabelText("Unread")).toBeNull();

    fireEvent.click(row);
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledTimes(1));
  });

  it("styles unread rows bold and read rows normal", () => {
    mocks.emails = [
      email({ id: "message-1", read: false, labels: ["inbox", "unread"] }),
      email({
        id: "message-2",
        threadId: "other-thread",
        read: true,
        labels: ["inbox", "read"],
      }),
    ];
    const { container } = render(<MailInbox />);
    const rows = Array.from(
      container.querySelectorAll("[data-mail-thread-row]"),
    );
    const unreadRow = rows.find(
      (row) => row.getAttribute("href") === "/mail/message-1",
    )!;
    const readRow = rows.find(
      (row) => row.getAttribute("href") === "/mail/message-2",
    )!;

    expect(unreadRow.querySelector(".font-bold")).not.toBeNull();
    expect(readRow.querySelector(".font-bold")).toBeNull();
    expect(readRow.querySelector(".font-normal")).not.toBeNull();
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

  it("releases the focused mail row on Escape so printable keys are no longer mail shortcuts", async () => {
    mocks.emails = [email({ id: "message-1" })];
    const { container } = render(<MailInbox />);

    expect(
      container.querySelector('[data-mail-index-focused="true"]'),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "e" });

    expect(
      container.querySelector('[data-mail-index-focused="false"]'),
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.archiveOne).not.toHaveBeenCalled());
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

function draft(): DraftDto {
  return {
    id: "01SYNTHETICDRAFT0000000000",
    created: "2026-07-23T09:00:00-07:00",
    kind: "new",
    fromInbox: "gmail:mail@example.com",
    to: ["recipient@example.test"],
    cc: [],
    bcc: [],
    subject: "Synthetic draft",
    body: "Durable draft content",
    sourceMessageId: null,
    threadId: null,
  };
}
