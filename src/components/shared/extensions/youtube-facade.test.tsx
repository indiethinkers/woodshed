import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({
  isTauriRuntime: () => true,
}));

import { YoutubeFacade } from "./youtube-facade";

describe("YoutubeFacade", () => {
  afterEach(cleanup);

  it("shows the video thumbnail before playback", () => {
    render(
      <YoutubeFacade
        url="https://www.youtube.com/watch?v=demoVideoId"
        videoId="demoVideoId"
      />,
    );

    expect(
      screen.getByRole("img", { name: "YouTube video thumbnail" }),
    ).toHaveAttribute(
      "src",
      "wsmail://localhost/img/aHR0cHM6Ly9pLnl0aW1nLmNvbS92aS9kZW1vVmlkZW9JZC9ocWRlZmF1bHQuanBn",
    );
  });
});
