import { describe, expect, it } from "vitest";
import { hasSurfaceListPanel } from "./title-bar";

describe("hasSurfaceListPanel", () => {
  it("includes mail routes", () => {
    expect(hasSurfaceListPanel("/mail")).toBe(true);
    expect(hasSurfaceListPanel("/mail/message-123")).toBe(true);
  });

  it("includes the record surfaces that render a list panel", () => {
    expect(hasSurfaceListPanel("/notebook")).toBe(true);
    expect(hasSurfaceListPanel("/notebook/some-note")).toBe(true);
    expect(hasSurfaceListPanel("/people/alex-rivera")).toBe(true);
    expect(hasSurfaceListPanel("/resources")).toBe(true);
    expect(hasSurfaceListPanel("/agent")).toBe(true);
    expect(hasSurfaceListPanel("/databases/tags/idea")).toBe(true);
  });

  it("excludes panel-less routes", () => {
    expect(hasSurfaceListPanel("/settings")).toBe(false);
    expect(hasSurfaceListPanel("/welcome")).toBe(false);
  });
});
