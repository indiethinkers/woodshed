// Date helpers consumed by both DatePicker (the popover) and TaskEditor
// (which renders its own CalendarGrid inline). Kept in a non-JSX module
// so the .tsx files that contain components can be Fast-Refreshed
// without losing local state on every edit.

export function monthStart(dateStr: string): Date {
  const d = new Date(dateStr + "T00:00:00");
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
