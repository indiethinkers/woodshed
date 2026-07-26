import { describe, expect, it } from "vitest";
import {
  normalizeTagDraft,
  normalizeTagList,
  normalizeTagToken,
} from "./tag-editor";

describe("tag normalization", () => {
  it("normalizes one tag token", () => {
    expect(normalizeTagToken(" #Knowledge-Management ")).toBe(
      "knowledge-management",
    );
    expect(normalizeTagToken("###Idea!")).toBe("idea");
    expect(normalizeTagToken("###")).toBeNull();
  });

  it("parses comma and whitespace separated input", () => {
    expect(normalizeTagDraft("#Idea, local-first sponsor")).toEqual([
      "idea",
      "local-first",
      "sponsor",
    ]);
  });

  it("deduplicates without changing first-seen order", () => {
    expect(normalizeTagList(["Idea", "#idea", "task", "Task"])).toEqual([
      "idea",
      "task",
    ]);
  });
});
