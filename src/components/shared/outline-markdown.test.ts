import { describe, expect, it } from "vitest";
import { unwrapGeneratedOutlineMarkdown } from "./outline-markdown";

describe("unwrapGeneratedOutlineMarkdown", () => {
  it("unwraps old outline rows with the trailing affordance into plain paragraphs", () => {
    expect(unwrapGeneratedOutlineMarkdown("- One\n- Two\n- Three\n- ")).toBe(
      "One\n\nTwo\n\nThree",
    );
  });

  it("unwraps nested outline rows without preserving list markers", () => {
    expect(unwrapGeneratedOutlineMarkdown("- Parent\n  - Child\n- ")).toBe(
      "Parent\n\nChild",
    );
  });

  it("drops a blank trailing outline affordance", () => {
    expect(unwrapGeneratedOutlineMarkdown("- Notes\n- ")).toBe("Notes");
  });

  it("leaves mixed prose and real lists alone", () => {
    const markdown = "Intro\n\n- Real list item";
    expect(unwrapGeneratedOutlineMarkdown(markdown)).toBe(markdown);
  });

  it("leaves normal all-list markdown alone", () => {
    const markdown = "- One\n- Two\n- Three";
    expect(unwrapGeneratedOutlineMarkdown(markdown)).toBe(markdown);
  });
});
