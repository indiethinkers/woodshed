import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResourceDto } from "@/lib/hooks/use-resources";
import { TwitterEmbed } from "./twitter-embed";

const TWEET_URL = "https://twitter.com/jack/status/20";

function renderEmbed(preview?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (preview) {
    const resource: ResourceDto = {
      id: "saved-post",
      path: "resources/saved-post.md",
      title: preview,
      url: TWEET_URL,
      source: "x.com",
      saved: "2026-07-31T00:00:00Z",
      tags: ["twitter"],
      highlights: [],
      favorite: false,
      body: "",
    };
    client.setQueryData(["resources"], [resource]);
  }
  return render(
    <QueryClientProvider client={client}>
      <TwitterEmbed
        tweetId="20"
        url={TWEET_URL}
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
      TWEET_URL,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("offers to refresh previews captured with the former truncation limit", () => {
    renderEmbed("Author on X: An older saved preview…");

    expect(document.querySelector(".twitter-embed-refresh")).toHaveTextContent(
      "Refresh full preview",
    );
  });
});
