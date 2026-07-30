import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { YoutubeFacade } from "./youtube-facade";

describe("YoutubeFacade", () => {
  afterEach(cleanup);

  it("renders the native privacy-enhanced player immediately", () => {
    render(
      <YoutubeFacade
        url="https://www.youtube.com/watch?v=demoVideoId"
        videoId="demoVideoId"
      />,
    );

    expect(screen.getByTitle("YouTube video demoVideoId")).toHaveAttribute(
      "src",
      "https://www.youtube-nocookie.com/embed/demoVideoId?rel=0&modestbranding=1",
    );
    expect(screen.getByTitle("YouTube video demoVideoId")).toHaveAttribute(
      "referrerpolicy",
      "strict-origin-when-cross-origin",
    );
    expect(
      screen.getByRole("button", { name: "Copy YouTube link" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open YouTube link" }),
    ).toBeInTheDocument();
  });
});
