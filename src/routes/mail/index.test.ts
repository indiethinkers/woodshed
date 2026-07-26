import { describe, expect, it } from "vitest";
import { validateMailSearch } from "./index";

describe("mail route search", () => {
  it("selects AI Sweep only for the explicit sweep mode", () => {
    expect(validateMailSearch({ mode: "sweep" })).toEqual({ mode: "sweep" });
  });

  it("defaults missing or invalid modes to Inbox", () => {
    expect(validateMailSearch({})).toEqual({});
    expect(validateMailSearch({ mode: "inbox" })).toEqual({});
    expect(validateMailSearch({ mode: "anything-else" })).toEqual({});
  });
});
