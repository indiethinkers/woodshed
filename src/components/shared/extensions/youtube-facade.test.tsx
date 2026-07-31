import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { YoutubeFacade } from "./youtube-facade";

describe("YoutubeFacade", () => {
  afterEach(cleanup);

  it("renders the native YouTube player immediately", () => {
    render(
      <YoutubeFacade
        url="https://www.youtube.com/watch?v=demoVideoId"
        videoId="demoVideoId"
      />,
    );

    expect(screen.getByTitle("YouTube video demoVideoId")).toHaveAttribute(
      "src",
      "https://www.youtube.com/embed/demoVideoId?rel=0&widget_referrer=http%3A%2F%2Flocalhost%3A3000%2F",
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
