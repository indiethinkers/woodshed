import { describe, expect, it } from "vitest";
import { dailyEditorValue } from "./daily-editor-value";

describe("dailyEditorValue", () => {
  it("seeds empty daily journals with a blank list item for placeholder parity", () => {
    expect(dailyEditorValue("")).toBe("- ");
    expect(dailyEditorValue("\n\n")).toBe("- ");
  });

  it("preserves existing journal markdown", () => {
    expect(dailyEditorValue("- ")).toBe("- ");
    expect(dailyEditorValue("Plain note")).toBe("Plain note");
    expect(dailyEditorValue("- Existing bullet")).toBe("- Existing bullet");
  });

  it("repairs a literal bullet captured inside a timestamped row", () => {
    expect(
      dailyEditorValue(
        "- [08:51] Projects for the August Release:\n- [08:52] - A\n- [08:52] B",
      ),
    ).toBe("- [08:51] Projects for the August Release:\n  - A\n  - B");
  });

  it("keeps a later timestamped row at the top level", () => {
    expect(
      dailyEditorValue(
        "- [08:51] Projects:\n- [08:52] - A\n- [08:53] Next thought",
      ),
    ).toBe("- [08:51] Projects:\n  - A\n- [08:53] Next thought");
  });
});
