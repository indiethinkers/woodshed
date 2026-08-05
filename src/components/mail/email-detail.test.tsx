import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EmailSummary } from "@/lib/mail-lib/types";
import { useAutoMarkRead } from "./email-detail";

describe("useAutoMarkRead", () => {
  it("continues with every unread message when the first optimistic update rerenders", async () => {
    const first = email({ id: "message-1", read: false });
    const second = email({ id: "message-2", read: false });
    let finishFirst!: () => void;
    const markRead = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const { rerender } = renderHook(
      ({ messages }) => useAutoMarkRead(messages, false, markRead),
      { initialProps: { messages: [first, second] } },
    );

    await waitFor(() => expect(markRead).toHaveBeenCalledWith(first.id));
    rerender({ messages: [{ ...first, read: true }, second] });

    await waitFor(() => expect(markRead).toHaveBeenCalledWith(second.id));
    finishFirst();
  });

  it("does not retry a failed message on each unread-state render", async () => {
    const message = email({ read: false, labels: ["inbox", "unread"] });
    const markRead = vi.fn().mockRejectedValue(new Error("remote read failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { rerender } = renderHook(
      ({ messages }) => useAutoMarkRead(messages, false, markRead),
      { initialProps: { messages: [message] } },
    );

    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));
    rerender({ messages: [{ ...message }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(markRead).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("leaves a message that arrives while reading earlier mail unread", async () => {
    const opened = email({ id: "message-1", read: false });
    const arriving = email({ id: "message-2", read: false });
    const markRead = vi.fn().mockResolvedValue(undefined);

    const { rerender } = renderHook(
      ({ messages }) => useAutoMarkRead(messages, false, markRead, () => false),
      { initialProps: { messages: [opened] } },
    );

    // The messages present when the thread opened are marked read.
    await waitFor(() => expect(markRead).toHaveBeenCalledWith("message-1"));

    // A message that syncs in while the user reads earlier mail must NOT
    // become read before it's ever seen.
    rerender({ messages: [opened, arriving] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markRead).not.toHaveBeenCalledWith("message-2");
  });

  it("marks a message that arrives while following the newest message", async () => {
    const opened = email({ id: "message-1", read: false });
    const arriving = email({ id: "message-2", read: false });
    const markRead = vi.fn().mockResolvedValue(undefined);

    const { rerender } = renderHook(
      ({ messages }) => useAutoMarkRead(messages, false, markRead, () => true),
      { initialProps: { messages: [opened] } },
    );

    await waitFor(() => expect(markRead).toHaveBeenCalledWith("message-1"));

    // While the user is watching the newest position, an arrival is seen.
    rerender({ messages: [opened, arriving] });
    await waitFor(() => expect(markRead).toHaveBeenCalledWith("message-2"));
  });

  it("does not re-capture the initial unread set after a loading cycle", async () => {
    const first = email({ id: "message-1", read: false });
    const arriving = email({ id: "message-2", read: false });
    const markRead = vi.fn().mockResolvedValue(undefined);

    const { rerender } = renderHook(
      ({ messages, isLoading }) =>
        useAutoMarkRead(messages, isLoading, markRead, () => false),
      { initialProps: { messages: [] as EmailSummary[], isLoading: true } },
    );

    // The initial set is captured on the first non-loading run with content.
    rerender({ messages: [first], isLoading: false });
    await waitFor(() => expect(markRead).toHaveBeenCalledWith("message-1"));

    // A later loading cycle must NOT re-capture: an arrival that lands
    // during it is still gated on isFollowingNewest (false → stays unread).
    rerender({ messages: [first, arriving], isLoading: true });
    rerender({ messages: [first, arriving], isLoading: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markRead).not.toHaveBeenCalledWith("message-2");
  });
});

function email(overrides: Partial<EmailSummary>): EmailSummary {
  return {
    id: "message-1",
    threadId: "thread-1",
    from: "Sender",
    fromEmail: "sender@example.test",
    subject: "Project update",
    body: "Body",
    html: null,
    preview: "Body",
    date: "2026-07-28T09:00:00-07:00",
    read: true,
    labels: ["inbox", "read"],
    mentions: [],
    links: [],
    inbox: "gmail:reader@example.test",
    path: "inbox/message-1.md",
    attachments: [],
    ...overrides,
  };
}
