import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TwitterEmbed } from "./twitter-embed";

function renderEmbed() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TwitterEmbed
        tweetId="20"
        url="https://twitter.com/jack/status/20"
        handle="jack"
      />
    </QueryClientProvider>,
  );
}

describe("TwitterEmbed", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders a static card without loading remote scripts", () => {
    renderEmbed();

    expect(document.querySelector("iframe")).toBeNull();
    expect(
      document.querySelector('script[src*="platform.twitter.com"]'),
    ).toBeNull();
    expect(document.querySelector(".twitter-embed-fallback")).toBeInTheDocument();
  });

  it("opens the original tweet URL when clicked", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    renderEmbed();

    fireEvent.click(document.querySelector(".twitter-embed-hit-target")!);

    expect(open).toHaveBeenCalledWith(
      "https://twitter.com/jack/status/20",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
