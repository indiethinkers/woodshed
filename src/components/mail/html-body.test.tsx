import { fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/lib/open-external", () => ({
  openExternalUrl: vi.fn(),
}));

import { HtmlBody } from "./html-body";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("HtmlBody", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      cacheId: "message-1:remote-images",
      hasRemoteImages: true,
    });
  });

  it("loads remote images through the bounded cache by default", async () => {
    const { queryByRole } = render(<HtmlBody messageId="message-1" />, {
      wrapper,
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("email_body_render", {
        id: "message-1",
        loadRemoteImages: true,
      });
    });
    expect(
      queryByRole("button", { name: "Load remote images" }),
    ).not.toBeInTheDocument();
  });

  it("forwards wheel deltas from the email iframe to the page scroll container", async () => {
    const scrollContainerRef = { current: null as HTMLDivElement | null };
    const { container } = render(
      <div
        data-woodshed-content-scroll
        ref={(el) => {
          scrollContainerRef.current = el;
        }}
      >
        <HtmlBody messageId="message-1" />
      </div>,
      { wrapper },
    );

    await waitFor(() => {
      expect(container.querySelector("iframe")).not.toBeNull();
    });

    const iframe = container.querySelector("iframe")!;
    // The bridge inside the iframe posts wheels to the parent; the parent
    // must scroll its own scroll container (the iframe never scrolls
    // internally because it is sized to its content).
    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "wsmail-wheel", deltaY: 120, deltaX: 0 },
        source: iframe.contentWindow,
      }),
    );

    expect(scrollContainerRef.current?.scrollTop).toBe(120);
  });
});
