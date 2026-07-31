import { describe, expect, it } from "vitest";
import { stripEmptyTimestampBulletsFromMarkdown } from "./daily-timestamps";

describe("stripEmptyTimestampBulletsFromMarkdown", () => {
  it("matches the backend cleanup for empty timestamp bullets", () => {
    expect(
      stripEmptyTimestampBulletsFromMarkdown(
        "- [09:30] Parent\n  - Child\n- [09:31] ",
      ),
    ).toBe("- [09:30] Parent\n  - Child");
  });

  it("keeps timestamp bullets that contain note text", () => {
    const body = "- [09:30] Parent\n- [09:31] Follow-up";
    expect(stripEmptyTimestampBulletsFromMarkdown(body)).toBe(body);
  });

  it("keeps a timestamp-only bullet when it owns an embed continuation", () => {
    const body =
      "- [09:30] Note\n- [09:31]\n  https://x.com/sample_account/status/1234567890123456789";
    expect(stripEmptyTimestampBulletsFromMarkdown(body)).toBe(body);
  });
});
