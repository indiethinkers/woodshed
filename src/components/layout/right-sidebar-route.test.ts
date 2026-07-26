import { describe, expect, it } from "vitest";
import { comparableReferenceHref, isSameReferencePage } from "./right-sidebar-route";

describe("right sidebar route comparison", () => {
  it("treats hash-only differences as the same page", () => {
    expect(isSameReferencePage("/notebook/example", "/notebook/example#intro")).toBe(
      true,
    );
  });

  it("normalizes trailing slashes", () => {
    expect(isSameReferencePage("/resources/video/", "/resources/video")).toBe(true);
  });

  it("preserves query params for page identity", () => {
    expect(
      isSameReferencePage(
        "/cadence/event/ical/work/abc?date=2026-06-27",
        "/cadence/event/ical/work/abc?date=2026-06-28",
      ),
    ).toBe(false);
  });

  it("normalizes absolute app urls to app paths", () => {
    expect(comparableReferenceHref("http://woodshed.local/people/jordan#bio")).toBe(
      "/people/jordan",
    );
  });
});
