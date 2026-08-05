import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSummary } from "@/lib/mail-lib/types";

const mocks = vi.hoisted(() => ({
  thread: [] as EmailSummary[],
  isLoading: true,
  navigate: vi.fn(),
  markRead: vi.fn(async () => {}),
}));

// jsdom has no ResizeObserver; the follow logic guards on its presence,
// so stub one to exercise the re-anchor-on-growth path.
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

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
vi.mock("@/components/mail/inline-reply", () => ({
  InlineReply: ({ message }: { message: EmailSummary }) => (
    <div data-testid="inline-reply">{message.id}</div>
  ),
}));
vi.mock("@/components/mail/snooze-button", () => ({
  SnoozeButton: () => <button type="button">Snooze</button>,
}));
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
    MockResizeObserver.instances = [];
  });

  it("expands every message in the thread once it loads", () => {
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

    // Gmail conversation view: the whole thread reads top to bottom —
    // no collapsed rows, no expand-to-read step for older messages.
    expect(screen.getByText("Older full body")).toBeInTheDocument();
    expect(screen.getByText("Newest full body")).toBeInTheDocument();
  });

  it("keeps a newly synchronized reply expanded next to the rest of the thread", () => {
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

    expect(screen.getByText("Previous latest body")).toBeInTheDocument();
    expect(screen.getByText("Synchronized reply body")).toBeInTheDocument();
  });

  it("scrolls the newest message's bottom into view when a thread loads", () => {
    const older = email({ id: "older-message", body: "Older full body" });
    const newest = email({
      id: "newest-message",
      body: "Newest full body",
      date: "2026-07-28T10:00:00Z",
    });
    mocks.thread = [older, newest];
    mocks.isLoading = false;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const { container } = render(<EmailDetail email={older} />);

    // Opening a thread lands at the BOTTOM of the newest message —
    // `block: "end"`, not "nearest", so a newest message taller than the
    // viewport shows its newest content instead of its top edge.
    const messageEls = container.querySelectorAll("[data-mail-thread-message]");
    expect(messageEls).toHaveLength(2);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    expect(scrollIntoView.mock.instances[0]).toBe(messageEls[1]);
  });

  it("scrolls the focused message with block nearest when navigating with j/k", () => {
    const older = email({ id: "older-message", body: "Older full body" });
    const newest = email({
      id: "newest-message",
      body: "Newest full body",
      date: "2026-07-28T10:00:00Z",
    });
    mocks.thread = [older, newest];
    mocks.isLoading = false;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(<EmailDetail email={older} />);
    scrollIntoView.mockClear();

    fireEvent.keyDown(window, { key: "j" });

    // Keyboard navigation uses a minimal "nearest" scroll (auto-follow
    // is what pins to the bottom), and the target is the newer message.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    const messageEls = document.querySelectorAll("[data-mail-thread-message]");
    expect(scrollIntoView.mock.instances[0]).toBe(messageEls[1]);
  });

  it("re-anchors to the newest message when thread content grows after load", () => {
    const older = email({ id: "older-message", body: "Older full body" });
    const newest = email({
      id: "newest-message",
      body: "Newest full body",
      date: "2026-07-28T10:00:00Z",
    });
    mocks.thread = [older, newest];
    mocks.isLoading = false;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const { container } = render(<EmailDetail email={older} />);
    scrollIntoView.mockClear();

    // An email body's auto-height iframe reports its real height after
    // mount; the thread grows and the follow pins the newest message's
    // bottom back to the viewport bottom.
    const messageEls = container.querySelectorAll("[data-mail-thread-message]");
    const observer = MockResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();
    observer!.callback([], observer as unknown as ResizeObserver);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    expect(scrollIntoView.mock.instances[0]).toBe(messageEls[1]);
  });

  it("stops following once the user scrolls away from the newest message", () => {
    const older = email({ id: "older-message", body: "Older full body" });
    const newest = email({
      id: "newest-message",
      body: "Newest full body",
      date: "2026-07-28T10:00:00Z",
    });
    mocks.thread = [older, newest];
    mocks.isLoading = false;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    // The rendered container's child doubles as the scroll-area viewport
    // so the follow machinery attaches its scroll listener. (scroll
    // events don't bubble, so the event must fire on the viewport itself,
    // not the testing-library wrapper.)
    const { container } = render(
      <div data-slot="scroll-area-viewport">
        <EmailDetail email={older} />
      </div>,
    );
    const viewport = container.firstElementChild as HTMLElement;
    scrollIntoView.mockClear();

    // Simulate the user scrolling up: the newest message's bottom no
    // longer sits at the viewport bottom and the viewport is not at the
    // end of the thread.
    const messageEls = container.querySelectorAll("[data-mail-thread-message]");
    vi.spyOn(messageEls[1], "getBoundingClientRect").mockReturnValue({
      bottom: 800,
    } as DOMRect);
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      bottom: 400,
    } as DOMRect);
    Object.defineProperty(viewport, "scrollHeight", {
      value: 900,
      configurable: true,
    });
    Object.defineProperty(viewport, "clientHeight", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(viewport, "scrollTop", {
      value: 200,
      configurable: true,
    });
    fireEvent.scroll(viewport);

    // Late content growth must not yank the view back down.
    const observer = MockResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();
    observer!.callback([], observer as unknown as ResizeObserver);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps the follow alive across a re-run while disengaged, so scrolling back re-engages it", () => {
    const older = email({ id: "older-message", body: "Older full body" });
    const newest = email({
      id: "newest-message",
      body: "Newest full body",
      date: "2026-07-28T10:00:00Z",
    });
    mocks.thread = [older, newest];
    mocks.isLoading = false;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const { container, rerender } = render(
      <div data-slot="scroll-area-viewport">
        <EmailDetail email={older} />
      </div>,
    );
    const viewport = container.firstElementChild as HTMLElement;
    // Drop the mount-time pin; the disengage/re-engage flow below is
    // what's under test (the mount rAF re-pin never fires synchronously).
    scrollIntoView.mockClear();
    const geometry = (msgBottom: number, scrollTop: number) => {
      const messageEls = container.querySelectorAll(
        "[data-mail-thread-message]",
      );
      const latest = messageEls[messageEls.length - 1];
      vi.spyOn(latest, "getBoundingClientRect").mockReturnValue({
        bottom: msgBottom,
      } as DOMRect);
      vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
        bottom: 400,
      } as DOMRect);
      Object.defineProperty(viewport, "scrollHeight", {
        value: 900,
        configurable: true,
      });
      Object.defineProperty(viewport, "clientHeight", {
        value: 400,
        configurable: true,
      });
      Object.defineProperty(viewport, "scrollTop", {
        value: scrollTop,
        configurable: true,
      });
    };

    // User scrolls up: the newest message's bottom is no longer flush
    // with the viewport bottom, so the follow disengages.
    geometry(800, 200);
    fireEvent.scroll(viewport);

    // A reply syncs into the open thread; the effect re-runs while
    // disengaged. It must not yank the view down...
    const synchronizedReply = email({
      id: "synchronized-reply",
      body: "Synchronized reply body",
      date: "2026-07-28T11:00:00Z",
    });
    mocks.thread = [older, newest, synchronizedReply];
    rerender(
      <div data-slot="scroll-area-viewport">
        <EmailDetail email={older} />
      </div>,
    );
    // The re-run while disengaged must not yank the view down.
    expect(scrollIntoView).not.toHaveBeenCalled();
    scrollIntoView.mockClear();

    // ...but the listener must survive the re-run, so scrolling back to
    // the newest position re-engages the follow...
    geometry(400, 500);
    fireEvent.scroll(viewport);

    // ...and subsequent content growth re-anchors to the newest message.
    const observer = MockResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();
    observer!.callback([], observer as unknown as ResizeObserver);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    const messageEls = container.querySelectorAll("[data-mail-thread-message]");
    expect(scrollIntoView.mock.instances[0]).toBe(messageEls[2]);
  });

  it("renders a sender avatar with initials for every message", () => {
    const older = email({ id: "older-message" });
    const newest = email({
      id: "newest-message",
      date: "2026-07-28T10:00:00Z",
    });
    mocks.thread = [older, newest];
    mocks.isLoading = false;

    render(<EmailDetail email={newest} />);

    // "Synthetic Sender" → "SS", one avatar per expanded message.
    expect(screen.getAllByText("SS")).toHaveLength(2);
  });

  it("offers Reply All for the thread and hover reply controls per message", () => {
    const older = email({ id: "older-message" });
    const newest = email({
      id: "newest-message",
      body: "Newest full body",
      date: "2026-07-28T10:00:00Z",
    });
    mocks.thread = [older, newest];
    mocks.isLoading = false;

    render(<EmailDetail email={newest} />);

    // One set in the header action bar + one hover set per message.
    expect(screen.getAllByRole("button", { name: "Reply" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Reply all" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Forward" })).toHaveLength(3);

    // The older message's hover Reply all targets that message.
    const replyAllButtons = screen.getAllByRole("button", { name: "Reply all" });
    fireEvent.click(replyAllButtons[1]);
    expect(
      screen.getByRole("dialog", { name: "Synthetic compose" }),
    ).toHaveTextContent("replyAll:older-message");
  });

  it("hides quoted reply history behind a Show trimmed content toggle", () => {
    const message = email({
      id: "message-1",
      body: [
        "Fresh reply.",
        "",
        "On Tue, Jul 28, 2026 at 9:00 AM Jordan <jordan@example.test> wrote:",
        "",
        "> Sounds good. I will review the pull request tonight and leave",
        "> inline comments where the design needs another pass first.",
        "> Keep it up — the demo on Friday should go smoothly.",
        "> We can ship on Monday if nothing else surfaces.",
        "> Talk soon.",
      ].join("\n"),
    });
    mocks.thread = [message];
    mocks.isLoading = false;

    render(<EmailDetail email={message} />);

    expect(screen.getByText("Fresh reply.")).toBeInTheDocument();
    expect(screen.queryByText(/Sounds good/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Show trimmed content" }),
    );
    expect(screen.getByText(/Sounds good/)).toBeInTheDocument();
  });

  it("always shows the collapsed reply strip at the bottom of the thread", () => {
    const message = email({ id: "message-1" });
    mocks.thread = [message];
    mocks.isLoading = false;

    render(<EmailDetail email={message} />);

    expect(screen.getByText("Click here to")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reply to this thread" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Forward this thread" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("inline-reply")).not.toBeInTheDocument();
  });

  it("expands the strip into an inline reply for the focused message", () => {
    const older = email({ id: "older-message" });
    const newest = email({
      id: "newest-message",
      date: "2026-07-28T10:00:00Z",
    });
    mocks.thread = [older, newest];
    mocks.isLoading = false;

    render(<EmailDetail email={newest} />);

    // The cursor starts on the newest message, so the strip replies to it.
    fireEvent.click(
      screen.getByRole("button", { name: "Reply to this thread" }),
    );
    expect(screen.getByTestId("inline-reply")).toHaveTextContent(
      "newest-message",
    );
  });

  it("forwards the latest message from the strip", () => {
    const message = email({ id: "message-1" });
    mocks.thread = [message];
    mocks.isLoading = false;

    render(<EmailDetail email={message} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Forward this thread" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Synthetic compose" }),
    ).toHaveTextContent("forward:message-1");
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
