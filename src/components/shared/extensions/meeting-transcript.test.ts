import { describe, expect, it } from "vitest";
import { sanitizeTranscriptHtml } from "./meeting-transcript";

describe("sanitizeTranscriptHtml", () => {
  it("keeps transcript formatting while dropping executable markup", () => {
    const output = sanitizeTranscriptHtml(
      '<p onclick="evil()"><strong>Dan</strong> hello<script>evil()</script><img src=x onerror=evil()></p>',
    );
    expect(output).toContain("<p><strong>Dan</strong> hello</p>");
    expect(output).not.toContain("script");
    expect(output).not.toContain("onclick");
    expect(output).not.toContain("img");
  });
});
