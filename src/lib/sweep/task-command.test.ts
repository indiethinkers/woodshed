import { describe, expect, it } from "vitest";
import { parseSweepTaskCommand } from "./task-command";

describe("parseSweepTaskCommand", () => {
  const noon = new Date(2026, 5, 14, 12, 0, 0);

  it("detects create-task requests scheduled for tomorrow in local time", () => {
    expect(parseSweepTaskCommand("create a task for tomorrow", noon)).toEqual({
      scheduled: "2026-06-15",
      dateLabel: "tomorrow",
    });
  });

  it("handles local date rollover at month boundaries", () => {
    const endOfMonth = new Date(2026, 5, 30, 23, 30, 0);
    expect(
      parseSweepTaskCommand("add this as a task tomorrow", endOfMonth),
    ).toEqual({
      scheduled: "2026-07-01",
      dateLabel: "tomorrow",
    });
  });

  it("detects unscheduled task requests", () => {
    expect(parseSweepTaskCommand("turn this email into a task", noon)).toEqual(
      {},
    );
  });

  it("extracts standalone task content from reminder wording", () => {
    expect(
      parseSweepTaskCommand(
        "create a task reminding me to read the Honeycrisp essay tomorrow",
        noon,
      ),
    ).toEqual({
      scheduled: "2026-06-15",
      dateLabel: "tomorrow",
      content: "Read the Honeycrisp essay",
    });
  });

  it("ignores draft requests and negated task requests", () => {
    expect(parseSweepTaskCommand("create a draft reply", noon)).toBeNull();
    expect(
      parseSweepTaskCommand("don't create a task for this", noon),
    ).toBeNull();
    expect(parseSweepTaskCommand("no task needed", noon)).toBeNull();
  });
});
