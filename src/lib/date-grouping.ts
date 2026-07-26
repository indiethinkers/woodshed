export interface DateGroup<T> {
  label: string;
  items: T[];
}

/**
 * Apple Notes-style date bucketing: Today / Yesterday / Previous 7 Days /
 * Previous 30 Days / month-name (this year) / year (older). Items are sorted
 * newest-first within each bucket; groups are returned in encounter order
 * (newest bucket first).
 */
export function groupByDate<T>(
  items: T[],
  getDate: (item: T) => string,
  referenceDate: Date,
): DateGroup<T>[] {
  const sorted = [...items].sort(
    (a, b) => parseDate(getDate(b)).getTime() - parseDate(getDate(a)).getTime(),
  );

  const buckets = new Map<string, T[]>();
  const order: string[] = [];

  const todayDay = startOfDay(referenceDate);
  const todayYear = todayDay.getFullYear();

  for (const item of sorted) {
    const itemDate = parseDate(getDate(item));
    const itemDay = startOfDay(itemDate);
    const days = Math.floor(
      (todayDay.getTime() - itemDay.getTime()) / (1000 * 60 * 60 * 24),
    );

    let label: string;
    if (days <= 0) label = "Today";
    else if (days === 1) label = "Yesterday";
    else if (days <= 7) label = "Previous 7 Days";
    else if (days <= 30) label = "Previous 30 Days";
    else if (itemDate.getFullYear() === todayYear) {
      label = itemDate.toLocaleDateString("en-US", { month: "long" });
    } else {
      label = String(itemDate.getFullYear());
    }

    if (!buckets.has(label)) {
      buckets.set(label, []);
      order.push(label);
    }
    buckets.get(label)!.push(item);
  }

  return order.map((label) => ({ label, items: buckets.get(label)! }));
}

export function formatShortDate(dateStr: string): string {
  const d = parseDate(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function parseDate(value: string): Date {
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateOnly) return new Date(value);
  const [, year, month, day] = dateOnly;
  return new Date(Number(year), Number(month) - 1, Number(day));
}
