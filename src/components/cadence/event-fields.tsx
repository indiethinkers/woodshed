import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown } from "lucide-react";
import type { EventDto } from "@/lib/hooks/use-events";
import { localDatePart, localTimePart } from "./datetime-utils";

/**
 * Click-to-open popover for editing an event's date / time / duration.
 * Used by both the vault-local event detail and the iCal event detail
 * (where the edit lands in the local-override file). Drafts seed when
 * the popover opens — not on every render — so an external watcher
 * update can't yank values out from under an in-progress edit. The
 * Done button (or click-outside) commits whichever fields changed via
 * the caller-supplied `onCommit`.
 */
export function DateTimeDurationField({
  event,
  onCommit,
}: {
  event: EventDto;
  onCommit: (next: { date: string; time: string; duration: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => localDatePart(event.date));
  const [time, setTime] = useState(() => localTimePart(event.date));
  const [duration, setDuration] = useState(event.duration);

  function handleOpenChange(next: boolean) {
    if (next) {
      setDate(localDatePart(event.date));
      setTime(localTimePart(event.date));
      setDuration(event.duration);
    } else if (open) {
      onCommit({ date, time, duration });
    }
    setOpen(next);
  }

  const d = new Date(event.date);

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger className="inline-flex items-center gap-1.5 px-1.5 py-0.5 -ml-1.5 rounded text-foreground hover:bg-foreground/[0.05] transition-colors">
        <span className="font-mono">
          {d.toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })}
        </span>
        <span className="text-muted-foreground">· {event.duration} min</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start">
          <Popover.Popup className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-3 min-w-[260px] space-y-2">
            <div className="grid grid-cols-[60px_1fr] items-center gap-2">
              <label htmlFor="event-date" className="text-[12px] text-muted-foreground">
                Date
              </label>
              <input
                id="event-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="px-2 h-8 text-sm rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
              />
              <label htmlFor="event-time" className="text-[12px] text-muted-foreground">
                Time
              </label>
              <input
                id="event-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="px-2 h-8 text-sm rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
              />
              <label htmlFor="event-duration" className="text-[12px] text-muted-foreground">
                Min
              </label>
              <input
                id="event-duration"
                type="number"
                min={5}
                max={1440}
                step={5}
                value={duration}
                onChange={(e) => setDuration(parseInt(e.target.value, 10) || 0)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleOpenChange(false);
                  }
                }}
                className="px-2 h-8 text-sm rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
              />
            </div>
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => handleOpenChange(false)}
                className="h-7 px-3 rounded-sm bg-accent text-accent-foreground text-[13px]"
              >
                Done
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
