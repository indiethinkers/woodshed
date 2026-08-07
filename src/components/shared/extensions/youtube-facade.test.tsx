import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { YoutubeFacade, youtubeWidgetReferrer } from "./youtube-facade";

describe("YoutubeFacade", () => {
  afterEach(cleanup);

  it("renders the cookie-free YouTube player immediately", () => {
    render(
      <YoutubeFacade
        url="https://www.youtube.com/watch?v=demoVideoId"
        videoId="demoVideoId"
      />,
    );

    // jsdom's default location is http://localhost:3000/, so the http(s)
    // referrer rule attaches widget_referrer.
    expect(screen.getByTitle("YouTube video demoVideoId")).toHaveAttribute(
      "src",
      "https://www.youtube-nocookie.com/embed/demoVideoId?rel=0&widget_referrer=http%3A%2F%2Flocalhost%3A3000%2F",
    );
    expect(screen.getByTitle("YouTube video demoVideoId")).toHaveAttribute(
      "referrerpolicy",
      "unsafe-url",
    );
    expect(
      screen.getByRole("button", { name: "Copy YouTube link" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open YouTube link" }),
    ).toBeInTheDocument();
  });
});

describe("youtubeWidgetReferrer", () => {
  it("attaches a referrer only for http(s) origins", () => {
    expect(
      youtubeWidgetReferrer({
        protocol: "http:",
        href: "http://localhost:5173/notebook/demo",
      }),
    ).toBe("http://localhost:5173/notebook/demo");
    expect(
      youtubeWidgetReferrer({
        protocol: "https:",
        href: "https://example.com/notes/demo",
      }),
    ).toBe("https://example.com/notes/demo");
  });

  it("omits the referrer for custom schemes and missing locations", () => {
    expect(
      youtubeWidgetReferrer({
        protocol: "tauri:",
        href: "tauri://localhost/notebook/demo",
      }),
    ).toBeNull();
    expect(
      youtubeWidgetReferrer({
        protocol: "file:",
        href: "file:///notes/demo",
      }),
    ).toBeNull();
    expect(youtubeWidgetReferrer(null)).toBeNull();
  });
});
