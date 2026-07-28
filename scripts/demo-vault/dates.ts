// Anchor-relative date arithmetic.
//
// Nothing in the demo dataset writes a literal date. Every timestamp is derived
// from an anchor — demo day — so the vault is always current when it is
// generated. This is the whole reason the built-in seed
// (`src-tauri/src/commands/seed.rs`, SEED_DATE = 2026-04-25) can't be used for
// a live demo: it opens on an empty Cadence.
//
// Calendar math runs in UTC so a machine's local timezone can never shift a
// record onto the wrong day. Wall-clock times, by contrast, are stamped with
// the *machine's* UTC offset: a demo scheduled for 18:30 has to read 18:30 on
// the projector, and a hardcoded offset silently shifts every event by the
// difference between that zone and the presenter's.

const MS_PER_DAY = 86_400_000;

/**
 * The machine's UTC offset for a specific local date and time, as `+HH:MM`.
 *
 * Resolved per timestamp rather than once, because the offset is not constant:
 * a vault spanning a DST boundary would otherwise put every record on one side
 * of it an hour out.
 */
function localOffset(isoDate: string, hours: number, minutes: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  // Constructed in local time, so getTimezoneOffset() reports the offset in
  // force on that date — DST included.
  const local = new Date(year, month - 1, day, hours, minutes, 0, 0);
  const eastOfUtc = -local.getTimezoneOffset();
  const sign = eastOfUtc < 0 ? "-" : "+";
  const abs = Math.abs(eastOfUtc);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const SUNDAY = 0;
export const SATURDAY = 6;

function parseIsoDate(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`expected a YYYY-MM-DD date, got "${iso}"`);
  }
  const stamp = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(stamp)) throw new Error(`invalid date: "${iso}"`);
  const date = new Date(stamp);
  // Date.parse accepts impossible days (2026-02-31) by rolling them over.
  // Round-tripping catches that.
  if (date.toISOString().slice(0, 10) !== iso) {
    throw new Error(`invalid calendar date: "${iso}"`);
  }
  return date;
}

/** Today in the machine's local timezone, as YYYY-MM-DD. */
export function todayLocal(): string {
  const now = new Date();
  const local = new Date(
    now.getTime() - now.getTimezoneOffset() * 60 * 1000,
  );
  return local.toISOString().slice(0, 10);
}

/**
 * The clock for a generated vault. Every content module takes one of these and
 * asks for offsets from demo day rather than naming dates.
 */
export class Calendar {
  readonly anchor: string;
  private readonly anchorDate: Date;

  constructor(anchor: string) {
    this.anchorDate = parseIsoDate(anchor);
    this.anchor = anchor;
  }

  /** `anchor + offset` days, as YYYY-MM-DD. Negative offsets go back in time. */
  day(offset: number): string {
    if (!Number.isInteger(offset)) {
      throw new Error(`day() offset must be a whole number, got ${offset}`);
    }
    const shifted = new Date(this.anchorDate.getTime() + offset * MS_PER_DAY);
    return shifted.toISOString().slice(0, 10);
  }

  /** Day of week for an offset, 0 = Sunday. */
  weekday(offset: number): Weekday {
    const shifted = new Date(this.anchorDate.getTime() + offset * MS_PER_DAY);
    return shifted.getUTCDay() as Weekday;
  }

  isWeekend(offset: number): boolean {
    const day = this.weekday(offset);
    return day === SATURDAY || day === SUNDAY;
  }

  /**
   * Nudge an offset onto the nearest weekday, searching forward. Recurring
   * standups and 1:1s run through this so no work event lands on a Saturday.
   */
  toWeekday(offset: number): number {
    let cursor = offset;
    while (this.isWeekend(cursor)) cursor += 1;
    return cursor;
  }

  /** Same, but searching backward — for "the last working day before X". */
  toWeekdayBefore(offset: number): number {
    let cursor = offset;
    while (this.isWeekend(cursor)) cursor -= 1;
    return cursor;
  }

  /**
   * RFC 3339 timestamp on the given day. `time` is 24-hour "HH:MM", and is the
   * wall-clock time the event should show at on this machine.
   */
  at(offset: number, time: string): string {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match) throw new Error(`expected HH:MM time, got "${time}"`);
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) {
      throw new Error(`time out of range: "${time}"`);
    }
    const date = this.day(offset);
    return `${date}T${match[1]}:${match[2]}:00${localOffset(date, hours, minutes)}`;
  }

  /**
   * Local-style timestamp with no zone suffix, e.g. 2026-07-27T09:30:00.
   * Notes and table rows use this shape (see `seed.rs` note/table `created`).
   */
  atNaive(offset: number, time: string): string {
    return this.at(offset, time).slice(0, 19);
  }

  /** Every offset in `[from, to]`, inclusive. */
  range(from: number, to: number): number[] {
    const out: number[] = [];
    for (let i = from; i <= to; i += 1) out.push(i);
    return out;
  }

  /** Offsets in `[from, to]` that fall on a weekday. */
  weekdays(from: number, to: number): number[] {
    return this.range(from, to).filter((offset) => !this.isWeekend(offset));
  }

  /**
   * Offsets in `[from, to]` landing on a specific weekday — the backbone of
   * recurring meetings (every Monday, every other Thursday…).
   */
  everyWeekdayNamed(from: number, to: number, target: Weekday): number[] {
    return this.range(from, to).filter(
      (offset) => this.weekday(offset) === target,
    );
  }
}
