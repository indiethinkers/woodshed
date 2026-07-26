import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TwitterEmbed } from "./twitter-embed";

describe("TwitterEmbed", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders a static card without loading remote scripts", () => {
    render(
      <TwitterEmbed
        tweetId="20"
        url="https://twitter.com/jack/status/20"
        handle="jack"
      />,
    );

    expect(document.querySelector("iframe")).toBeNull();
    expect(
      document.querySelector('script[src*="platform.twitter.com"]'),
    ).toBeNull();
    expect(document.querySelector(".twitter-embed-fallback")).toBeInTheDocument();
  });

  it("opens the original tweet URL when clicked", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <TwitterEmbed
        tweetId="20"
        url="https://twitter.com/jack/status/20"
        handle="jack"
      />,
    );

    fireEvent.click(document.querySelector(".twitter-embed-hit-target")!);

    expect(open).toHaveBeenCalledWith(
      "https://twitter.com/jack/status/20",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
