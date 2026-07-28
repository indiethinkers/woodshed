import { describe, expect, it } from "vitest";
import { Calendar, SATURDAY, SUNDAY } from "../../scripts/demo-vault/dates";

// 2026-07-27 is a Monday — handy as a fixed anchor so weekday assertions read
// plainly. The generator defaults to "today"; pinning here keeps the test
// deterministic.
const ANCHOR = "2026-07-27";

describe("Calendar.day", () => {
  it("returns the anchor at offset 0", () => {
    expect(new Calendar(ANCHOR).day(0)).toBe(ANCHOR);
  });

  it("walks backward across a month boundary", () => {
    const cal = new Calendar(ANCHOR);
    expect(cal.day(-56)).toBe("2026-06-01");
    expect(cal.day(-27)).toBe("2026-06-30");
  });

  it("walks forward across a month boundary", () => {
    expect(new Calendar(ANCHOR).day(14)).toBe("2026-08-10");
  });

  it("handles a leap day", () => {
    expect(new Calendar("2028-02-28").day(1)).toBe("2028-02-29");
  });

  it("rejects a non-integer offset", () => {
    expect(() => new Calendar(ANCHOR).day(1.5)).toThrow(/whole number/);
  });
});

describe("Calendar construction", () => {
  it("rejects a malformed date", () => {
    expect(() => new Calendar("July 27")).toThrow(/YYYY-MM-DD/);
  });

  it("rejects a date that does not exist", () => {
    expect(() => new Calendar("2026-02-31")).toThrow(/invalid calendar date/);
  });
});

describe("weekday snapping", () => {
  it("never returns a weekend offset", () => {
    const cal = new Calendar(ANCHOR);
    for (const offset of cal.range(-60, 20)) {
      expect(cal.isWeekend(cal.toWeekday(offset))).toBe(false);
      expect(cal.isWeekend(cal.toWeekdayBefore(offset))).toBe(false);
    }
  });

  it("leaves a weekday offset untouched", () => {
    const cal = new Calendar(ANCHOR);
    expect(cal.toWeekday(0)).toBe(0);
  });

  it("pushes Saturday forward to Monday and back to Friday", () => {
    const cal = new Calendar(ANCHOR);
    const saturday = cal.range(0, 13).find((o) => cal.weekday(o) === SATURDAY);
    expect(saturday).toBeDefined();
    expect(cal.toWeekday(saturday!)).toBe(saturday! + 2);
    expect(cal.toWeekdayBefore(saturday!)).toBe(saturday! - 1);
  });

  it("excludes weekends from weekdays()", () => {
    const cal = new Calendar(ANCHOR);
    const offsets = cal.weekdays(-14, 14);
    expect(offsets.length).toBeGreaterThan(0);
    for (const offset of offsets) {
      const day = cal.weekday(offset);
      expect(day === SATURDAY || day === SUNDAY).toBe(false);
    }
  });

  it("picks exactly one match per week in everyWeekdayNamed", () => {
    const cal = new Calendar(ANCHOR);
    // Four full weeks contains exactly four Wednesdays.
    expect(cal.everyWeekdayNamed(0, 27, 3)).toHaveLength(4);
  });
});

describe("timestamps", () => {
  it("emits parseable RFC 3339 carrying the machine's own offset", () => {
    const stamp = new Calendar(ANCHOR).at(0, "09:30");
    expect(stamp).toMatch(/^2026-07-27T09:30:00[+-]\d{2}:\d{2}$/);
    expect(Number.isNaN(Date.parse(stamp))).toBe(false);
  });

  it("renders back at the wall-clock time it was asked for", () => {
    // The bug this guards: a hardcoded offset made every event display at the
    // presenter's local time minus the difference between the two zones — an
    // 18:30 dinner showed at 15:30 on a Pacific machine.
    for (const time of ["08:30", "14:00", "18:30"]) {
      const parsed = new Date(new Calendar(ANCHOR).at(0, time));
      const shown = `${String(parsed.getHours()).padStart(2, "0")}:${String(
        parsed.getMinutes(),
      ).padStart(2, "0")}`;
      expect(shown).toBe(time);
    }
  });

  it("emits a naive timestamp with no zone suffix", () => {
    expect(new Calendar(ANCHOR).atNaive(0, "14:00")).toBe(
      "2026-07-27T14:00:00",
    );
  });

  it("rejects malformed and out-of-range times", () => {
    const cal = new Calendar(ANCHOR);
    expect(() => cal.at(0, "9:30")).toThrow(/HH:MM/);
    expect(() => cal.at(0, "24:00")).toThrow(/out of range/);
  });
});
