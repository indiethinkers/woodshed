import { describe, expect, it } from "vitest";
import { YOUTUBE_URL_RE } from "./youtube-resource";

const ID = "dQw4w9WgXcQ";

describe("YOUTUBE_URL_RE", () => {
  it("matches the whole URL so the load transform can swap a bare-URL paragraph", () => {
    // replaceUrlParagraphsWithEmbeds only converts a paragraph whose entire
    // text is the URL (`match[0] === text`), so the match must span it all.
    const url = `https://www.youtube.com/watch?app=desktop&v=${ID}&t=10s`;
    const match = url.match(YOUTUBE_URL_RE);
    expect(match?.[0]).toBe(url);
  });
});
