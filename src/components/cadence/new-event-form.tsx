import { useEffect, useRef, useState } from "react";
import { defaultAreas } from "@/lib/areas";
import { useAreas } from "@/lib/hooks/use-areas";
import { useEventMutations } from "@/lib/hooks/use-events";
import type { RecurringRule, AreaId } from "@/lib/types";
import { combineDateTime } from "./datetime-utils";

interface NewEventFormProps {
  /** YYYY-MM-DD; the day this event will be scheduled on. */
  date: string;
  /** Default time-of-day in 24h "HH:MM" form. */
  defaultTime?: string;
  /** Called after the event is successfully created. */
  onCreated: () => void;
  onCancel: () => void;
}
const RECURRING_OPTIONS: { value: RecurringRule; label: string }[] = [
  { value: "none", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

/**
 * Inline event creator. Renders a single-row form (title, time, duration,
 * area, recurring) for a date the caller already knows. Builds an ISO
 * datetime by combining the date with the user-entered time. The browser's
 * local timezone is used; events render in the same zone they were created.
 */
export function NewEventForm({
  date,
  defaultTime = "09:00",
  onCreated,
  onCancel,
}: NewEventFormProps) {
  const { create } = useEventMutations();
  const { data: liveAreas } = useAreas();
  const areas = liveAreas ?? defaultAreas;

  const [title, setTitle] = useState("");
  const [time, setTime] = useState(defaultTime);
  const [duration, setDuration] = useState(30);
  const [area, setArea] = useState<AreaId>(areas[0]?.id ?? "woodshed");
  const [recurring, setRecurring] = useState<RecurringRule>("none");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  async function commit() {
    const trimmed = title.trim();
    if (!trimmed || create.isPending) return;
    await create.mutateAsync({
      title: trimmed,
      date: combineDateTime(date, time),
      duration,
      area,
      recurring,
    });
    onCreated();
  }

  return (
    <div
      className="space-y-2 rounded-md border border-border bg-background/50 p-3 outline-none"
      onKeyDown={(e) => {
        // Keep printable keys / Enter / Escape from leaking to the global
        // type-anywhere command palette.
        if (e.key.length === 1 || e.key === "Enter" || e.key === "Escape") {
          e.stopPropagation();
        }
      }}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        New event
      </p>
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Event title"
        className="w-full px-2 h-8 text-sm rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      <div className="grid grid-cols-[80px_80px_1fr] gap-2">
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="px-2 h-8 text-sm rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
        />
        <input
          type="number"
          min={5}
          max={1440}
          step={5}
          value={duration}
          onChange={(e) => setDuration(parseInt(e.target.value, 10) || 30)}
          aria-label="Duration in minutes"
          className="px-2 h-8 text-sm rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
        />
        <select
          value={area}
          onChange={(e) => setArea(e.target.value)}
          aria-label="Area"
          className="px-2 h-8 text-sm rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
        >
          {areas.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <select
        value={recurring}
        onChange={(e) => setRecurring(e.target.value as RecurringRule)}
        aria-label="Recurrence"
        className="w-full px-2 h-8 text-sm rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      >
        {RECURRING_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="flex items-center justify-end gap-1.5 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={create.isPending}
          className="h-7 px-3 rounded-sm text-[13px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={create.isPending || !title.trim()}
          className="h-7 px-3 rounded-sm bg-accent text-accent-foreground text-[13px] disabled:opacity-50"
        >
          {create.isPending ? "Saving…" : "Add event"}
        </button>
      </div>
    </div>
  );
}
