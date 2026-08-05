import { describe, expect, it } from "vitest";
import { splitQuotedBody } from "./trim-quoted";

describe("splitQuotedBody", () => {
  it("returns the body untouched when there is no quoted section", () => {
    const body = "Just a normal message.\n\nNo history attached.";
    expect(splitQuotedBody(body)).toEqual({ body, quoted: null });
  });

  it("trims a Gmail-style wrote: block from the first separator line", () => {
    const body = [
      "Fresh reply.",
      "",
      "On Tue, Jul 28, 2026 at 9:00 AM Jordan <jordan@example.test> wrote:",
      "",
      "> Sounds good. I will review the pull request tonight and leave",
      "> inline comments where the design needs another pass first.",
      "> Keep it up — the demo on Friday should go smoothly.",
      "> We can ship on Monday if nothing else surfaces.",
      "> Talk soon.",
    ].join("\n");
    const { body: visible, quoted } = splitQuotedBody(body);

    expect(visible).toBe("Fresh reply.");
    expect(quoted).toContain("On Tue, Jul 28, 2026");
    expect(quoted).toContain("> Talk soon.");
  });

  it("trims a run of `>` prefixed lines", () => {
    const body = [
      "Reply text",
      "",
      "> older line",
      "> older line 2",
      "> older line 3",
      "> older line 4",
      "> older line 5",
    ].join("\n");
    const { body: visible, quoted } = splitQuotedBody(body);

    expect(visible).toBe("Reply text");
    expect(quoted?.split("\n")).toHaveLength(5);
  });

  it("keeps a tiny footer visible instead of hiding it", () => {
    const body = [
      "Sent.",
      "",
      "On Tue, Jul 28, 2026 at 9:00 AM Jordan wrote:",
      "",
      "> ok",
    ].join("\n");
    expect(splitQuotedBody(body).quoted).toBeNull();
  });

  it("trims a fully-quoted body to an empty visible part", () => {
    const body = [
      "On Tue, Jul 28, 2026 at 9:00 AM Jordan <jordan@example.test> wrote:",
      "",
      "> one more thing to check in the review",
      "> two more items before we ship",
      "> three — then we are done",
      "> four and we wrap up the thread",
      "> five, talk soon",
    ].join("\n");
    const { body: visible, quoted } = splitQuotedBody(body);

    expect(visible).toBe("");
    expect(quoted).toContain("> one more thing");
  });
});
