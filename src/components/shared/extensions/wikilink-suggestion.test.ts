import { describe, it, expect } from "vitest";

// Mirrors the regex in wikilink-suggestion.ts. If the picker matcher diverges
// from this, update both — the regex is load-bearing for picker UX.
const TRIGGER_RE = /\[\[([^[\]\n]*)$/;

describe("Wikilink suggestion trigger regex", () => {
  it("matches `[[` at end of text with empty query", () => {
    const m = "Hello [[".match(TRIGGER_RE);
    expect(m).toBeTruthy();
    expect(m?.[1]).toBe("");
  });

  it("matches `[[Alex` partial query", () => {
    const m = "Hello [[Alex".match(TRIGGER_RE);
    expect(m?.[1]).toBe("Alex");
  });

  it("matches `[[Alex Rivera` with internal space", () => {
    const m = "Lunch with [[Alex Rivera".match(TRIGGER_RE);
    expect(m?.[1]).toBe("Alex Rivera");
  });

  it("does NOT match a single `[`", () => {
    expect("text [".match(TRIGGER_RE)).toBeNull();
  });

  it("does NOT match `[text](url)` markdown link patterns", () => {
    // Single bracket — the standard link syntax — must not trigger the picker.
    expect("[docs](".match(TRIGGER_RE)).toBeNull();
  });

  it("does NOT match if `]]` already closed the link", () => {
    // Bracket pair already closed downstream — picker should be inactive.
    // We feed only the text up to the cursor; the matcher sees `[[Alex]]`
    // followed by nothing, so the regex doesn't match (no open trailing).
    const m = "[[Alex]]".match(TRIGGER_RE);
    expect(m).toBeNull();
  });

  it("does NOT match across newlines", () => {
    // The `[^[\]\n]*` capture group rejects newlines, so a `[[` on a
    // previous line followed by a fresh line shouldn't trigger.
    expect("[[\nfoo".match(TRIGGER_RE)).toBeNull();
  });

  it("does NOT match `[[[` (three brackets)", () => {
    // Three brackets would be ambiguous — typing `[[[`, the matcher should
    // see `[[` followed by `[`, but `[` is in the rejected char class so it
    // bails. (Alternatively the rule fires with empty query — either is OK.)
    const m = "[[[".match(TRIGGER_RE);
    // The match captures the second `[[` and an empty query. Acceptable —
    // user gets a picker on the trailing pair. Don't allow the leading `[`
    // to leak into the query though.
    expect(m?.[1]).toBe("");
  });
});
