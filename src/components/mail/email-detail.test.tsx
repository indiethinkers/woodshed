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
