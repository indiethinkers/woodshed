import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail, replyMail, saveDraft } = vi.hoisted(() => ({
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
  saveDraft: vi.fn(async (input) => ({
    ...input,
    id: input.id ?? "01SYNTHETICDRAFT0000000000",
    created: "2026-08-01T12:00:00Z",
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
  useSaveDraft: () => saveDraft,
  useDeleteDraft: () => vi.fn(async () => {}),
}));

import { ComposeDialog } from "./compose-dialog";

describe("ComposeDialog", () => {
  beforeEach(() => {
    sendMail.mockClear();
    replyMail.mockClear();
    saveDraft.mockClear();
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

  it("addresses Reply All to every participant except the connected account", () => {
    render(
      <ComposeDialog
        open
        mode={{
          kind: "replyAll",
          source: {
            id: "source-message@example.test",
            messageId: "source-message@example.test",
            threadId: "synthetic-thread",
            from: "Originator",
            fromEmail: "originator@example.test",
            to: [
              "sender@example.test",
              "collaborator@example.test",
              "originator@example.test",
            ],
            cc: ["observer@example.test", "sender@example.test"],
            subject: "Synthetic discussion",
            body: "A synthetic message body.",
            html: null,
            preview: "A synthetic message body.",
            date: "2026-07-28T10:00:00Z",
            read: true,
            labels: ["inbox", "read"],
            mentions: [],
            links: [],
            inbox: "gmail:sender@example.test",
            path: "inbox/source.md",
            attachments: [],
          },
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText("someone@example.com")).toHaveValue(
      "originator@example.test, collaborator@example.test",
    );
    expect(
      screen.getByText("Cc").parentElement?.querySelector("input"),
    ).toHaveValue("observer@example.test");
  });

  it("replies to the other participant when the selected message was sent by the user", () => {
    render(
      <ComposeDialog
        open
        mode={{
          kind: "reply",
          source: {
            id: "sent-message@example.test",
            threadId: "synthetic-thread",
            from: "Connected User",
            fromEmail: "sender@example.test",
            to: ["recipient@example.test"],
            cc: [],
            subject: "Synthetic discussion",
            body: "A sent message.",
            html: null,
            preview: "A sent message.",
            date: "2026-07-28T10:00:00Z",
            read: true,
            labels: ["sent", "read"],
            mentions: [],
            links: [],
            inbox: "gmail:sender@example.test",
            path: "sent/source.md",
            attachments: [],
          },
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText("someone@example.com")).toHaveValue(
      "recipient@example.test",
    );
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

  it("flushes the latest draft before closing", async () => {
    const onClose = vi.fn();
    render(
      <ComposeDialog open mode={{ kind: "new" }} onClose={onClose} />,
    );

    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "Latest synthetic edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(saveDraft).toHaveBeenCalledOnce());
    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Latest synthetic edit" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the composer open when the final draft save fails", async () => {
    const onClose = vi.fn();
    saveDraft.mockRejectedValueOnce(new Error("synthetic save failure"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ComposeDialog open mode={{ kind: "new" }} onClose={onClose} />,
    );

    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "Unsaved synthetic edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(
      await screen.findByText(
        "Draft could not be saved. Keep this window open and try again.",
      ),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
