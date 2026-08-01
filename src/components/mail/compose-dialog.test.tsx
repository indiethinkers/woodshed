import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail, replyMail } = vi.hoisted(() => ({
  sendMail: vi.fn(async () => ({
    messageId: "sent-message@example.test",
    threadId: "sent-message@example.test",
    sentAt: "2026-07-28T12:00:00Z",
  })),
  replyMail: vi.fn(async () => ({
    messageId: "reply-message@example.test",
    threadId: "synthetic-thread",
    sentAt: "2026-07-28T12:00:00Z",
  })),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/lib/hooks/use-mail", () => ({
  useInboxes: () => ({
    data: [
      {
        inboxId: "gmail:sender@example.test",
        email: "sender@example.test",
        displayName: "Synthetic inbox",
        createdAt: "2026-07-28T00:00:00Z",
      },
    ],
  }),
  useSendMail: () => sendMail,
  useReplyMail: () => replyMail,
  useSaveDraft: () => vi.fn(),
  useDeleteDraft: () => vi.fn(async () => {}),
}));

import { ComposeDialog } from "./compose-dialog";

describe("ComposeDialog", () => {
  beforeEach(() => {
    sendMail.mockClear();
    replyMail.mockClear();
  });

  it("resumes a saved reply draft with its original thread identity", async () => {
    render(
      <ComposeDialog
        open
        mode={{ kind: "new" }}
        draft={{
          id: "01SYNTHETICDRAFT0000000000",
          created: "2026-07-28T10:00:00Z",
          kind: "reply",
          fromInbox: "gmail:sender@example.test",
          to: ["recipient@example.test"],
          cc: [],
          bcc: [],
          subject: "",
          body: "Synthetic reply body",
          sourceMessageId: "source-message@example.test",
          threadId: "synthetic-thread",
        }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));

    await waitFor(() => expect(replyMail).toHaveBeenCalledOnce());
    expect(replyMail).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyToMessageId: "source-message@example.test",
        threadId: "synthetic-thread",
        body: "Synthetic reply body",
      }),
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("can expand and send user-selected attachments", async () => {
    render(
      <ComposeDialog
        open
        mode={{ kind: "new" }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand compose" }));
    expect(screen.getByRole("dialog", { name: "New message" })).toHaveAttribute(
      "data-expanded",
      "true",
    );

    fireEvent.change(screen.getByPlaceholderText("someone@example.com"), {
      target: { value: "recipient@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "Synthetic subject" },
    });
    fireEvent.change(screen.getByLabelText("Add attachments"), {
      target: {
        files: [new File(["hello"], "brief.txt", { type: "text/plain" })],
      },
    });

    expect(await screen.findByText("brief.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));

    await waitFor(() => expect(sendMail).toHaveBeenCalledOnce());
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            filename: "brief.txt",
            contentType: "text/plain",
            dataBase64: "aGVsbG8=",
          },
        ],
      }),
    );
  });

  it("includes a newly selected attachment when sending with the keyboard shortcut", async () => {
    render(
      <ComposeDialog open mode={{ kind: "new" }} onClose={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText("someone@example.com"), {
      target: { value: "recipient@example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "Synthetic subject" },
    });
    fireEvent.change(screen.getByLabelText("Add attachments"), {
      target: {
        files: [new File(["latest"], "latest.txt", { type: "text/plain" })],
      },
    });

    expect(await screen.findByText("latest.txt")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    await waitFor(() => expect(sendMail).toHaveBeenCalledOnce());
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            filename: "latest.txt",
            dataBase64: "bGF0ZXN0",
          }),
        ],
      }),
    );
  });
});
