import { describe, expect, it } from "vitest";
import { getPreview } from "./note-list";

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
