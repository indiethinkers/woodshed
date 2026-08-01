import { describe, expect, it } from "vitest";
import { getPreview } from "./note-list";
import { notebookFolders } from "./note-context-sidebar";

describe("getPreview", () => {
  it("strips markdown formatting from notebook list previews", () => {
    expect(
      getPreview(
        "**Note:** This reflection was written by `Codex`.\n\nSecond paragraph",
      ),
    ).toBe("Note: This reflection was written by Codex.");
  });

  it("keeps readable text from common markdown affordances", () => {
    expect(
      getPreview(
        "- [ ] Read [[Alex Rivera]] on [local-first](https://example.com) #idea",
      ),
    ).toBe("Read Alex Rivera on local-first");
  });
});

describe("notebookFolders", () => {
  it("builds a nested folder tree from existing Markdown paths", () => {
    const folders = notebookFolders([
      {
        id: "one",
        path: "Projects/Research/one.md",
        revision: "a",
        title: "One",
        created: "2026-01-01T00:00:00Z",
        tags: [],
        favorite: false,
        body: "",
        external: true,
        folder: "Projects/Research",
      },
      {
        id: "two",
        path: "Projects/two.md",
        revision: "b",
        title: "Two",
        created: "2026-01-02T00:00:00Z",
        tags: [],
        favorite: false,
        body: "",
        external: true,
        folder: "Projects",
      },
    ]);

    expect(folders).toEqual([
      { path: "Projects", name: "Projects", depth: 0, count: 2 },
      {
        path: "Projects/Research",
        name: "Research",
        depth: 1,
        count: 1,
      },
    ]);
  });
});
