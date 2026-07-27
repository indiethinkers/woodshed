import { render, waitFor } from "@testing-library/react";
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
});
