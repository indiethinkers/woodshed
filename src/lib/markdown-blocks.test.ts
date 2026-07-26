import { describe, expect, it } from "vitest";
import { parseMarkdownToBlocks } from "./markdown-blocks";

describe("markdown blocks section headers", () => {
  it("parses h6 markdown into a section header block", () => {
    const blocks = parseMarkdownToBlocks("###### Notes\n\nBody text");

    expect(blocks[0]).toMatchObject({
      kind: "sectionHeader",
      text: "Notes",
    });
    expect(blocks[1]).toMatchObject({
      kind: "paragraph",
      text: "Body text",
    });
  });

});

describe("markdown blocks twitter embeds", () => {
  it("parses a standalone X post URL into a twitter block", () => {
    const blocks = parseMarkdownToBlocks(
      "https://x.com/GregKamradt/status/1920204257806995814",
    );

    expect(blocks[0]).toMatchObject({
      kind: "twitter",
      handle: "GregKamradt",
      tweetId: "1920204257806995814",
    });
  });

  it("parses a standalone Markdown autolink X post URL into a twitter block", () => {
    const blocks = parseMarkdownToBlocks(
      "<https://x.com/karpathy/status/1617979122625712128?s=20>",
    );

    expect(blocks[0]).toMatchObject({
      kind: "twitter",
      handle: "karpathy",
      tweetId: "1617979122625712128",
      url: "https://x.com/karpathy/status/1617979122625712128?s=20",
    });
  });
});

describe("markdown blocks URL autolinks", () => {
  it("parses resource YouTube autolinks without stalling", () => {
    const blocks = parseMarkdownToBlocks(
      [
        "#resource #youtube",
        "",
        "<https://www.youtube.com/watch?v=zJB6SLQOrmg>",
        "",
        "<https://jdahl.substack.com/p/jasmine-sun>",
      ].join("\n"),
    );

    expect(blocks[0]).toMatchObject({
      kind: "youtube",
      videoId: "zJB6SLQOrmg",
      resource: true,
    });
    expect(blocks[1]).toMatchObject({
      kind: "paragraph",
      text: "<https://jdahl.substack.com/p/jasmine-sun>",
    });
  });
});

describe("markdown blocks fenced code", () => {
  it("parses fenced code with a language into a code block", () => {
    const blocks = parseMarkdownToBlocks(
      "Intro\n\n```ts\nconst answer: number = 42;\n```\n\nDone",
    );

    expect(blocks[1]).toMatchObject({
      kind: "code",
      language: "ts",
      code: "const answer: number = 42;",
    });
  });

});
