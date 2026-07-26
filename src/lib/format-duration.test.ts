import { describe, it, expect } from "vitest";
import { formatDuration, liveTimeSpent } from "./format-duration";

describe("formatDuration", () => {
  it("returns 0s for zero or negative", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-5)).toBe("0s");
  });

  it("formats seconds under a minute", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(59)).toBe("59s");
  });

  it("formats minutes with seconds remainder", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(3599)).toBe("59m 59s");
  });

  it("formats hours with minutes remainder", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(3725)).toBe("1h 2m");
  });

  it("formats days with hours remainder", () => {
    expect(formatDuration(86400)).toBe("1d");
    expect(formatDuration(90061)).toBe("1d 1h");
  });
});

describe("liveTimeSpent", () => {
  it("returns the accumulator when no active run", () => {
    expect(liveTimeSpent(60, undefined)).toBe(60);
  });

  it("adds elapsed seconds when a run is active", () => {
    const now = new Date("2026-04-26T12:00:00Z");
    const startedAt = "2026-04-26T11:59:50Z";
    expect(liveTimeSpent(60, startedAt, now)).toBe(70);
  });

  it("ignores invalid startedAt strings", () => {
    expect(liveTimeSpent(60, "not-a-date")).toBe(60);
  });
});
