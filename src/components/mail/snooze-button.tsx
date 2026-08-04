import { useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Clock3 } from "lucide-react";
import { toast } from "sonner";
import { useSnoozeOne } from "@/lib/hooks/use-mail";
import { Button } from "@/components/ui/button";

interface SnoozeButtonProps {
  messageIds: string[];
  compact?: boolean;
  onSnoozed?: () => void;
}

export function SnoozeButton({
  messageIds,
  compact = false,
  onSnoozed,
}: SnoozeButtonProps) {
  const snoozeOne = useSnoozeOne();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialCustom = useMemo(() => toDateTimeLocal(tomorrowMorning()), []);
  const [customTime, setCustomTime] = useState(initialCustom);

  async function snoozeUntil(deadline: Date) {
    if (Number.isNaN(deadline.getTime()) || deadline <= new Date()) {
      setError("Choose a future date and time.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await Promise.all(
        messageIds.map((id) => snoozeOne(id, deadline.toISOString())),
      );
      setOpen(false);
      toast.success(
        messageIds.length === 1 ? "Email snoozed" : "Email thread snoozed",
      );
      onSnoozed?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={compact ? "Snooze email" : undefined}
        title="Snooze"
        className={
          compact
            ? "rounded p-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            : undefined
        }
        render={
          compact ? undefined : (
            <Button variant="outline" size="sm" disabled={messageIds.length === 0} />
          )
        }
      >
        <Clock3 className={compact ? "h-4 w-4" : "mr-1.5 h-3.5 w-3.5"} />
        {!compact && "Snooze"}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="z-50" sideOffset={8} align="end">
          <Popover.Popup className="w-[280px] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none">
            <p className="mb-2 text-[12px] font-semibold">Return to inbox</p>
            <div className="grid gap-1">
              <SnoozeChoice
                label="Later today"
                detail="In 3 hours"
                disabled={pending}
                onClick={() => void snoozeUntil(addHours(new Date(), 3))}
              />
              <SnoozeChoice
                label="Tomorrow morning"
                detail="9:00 AM"
                disabled={pending}
                onClick={() => void snoozeUntil(tomorrowMorning())}
              />
              <SnoozeChoice
                label="Next week"
                detail="Monday at 9:00 AM"
                disabled={pending}
                onClick={() => void snoozeUntil(nextMondayMorning())}
              />
            </div>
            <div className="mt-3 border-t border-border pt-3">
              <label className="grid gap-1 text-[11px] text-muted-foreground">
                Custom date and time
                <input
                  type="datetime-local"
                  value={customTime}
                  disabled={pending}
                  onChange={(event) => setCustomTime(event.target.value)}
                  className="h-8 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                />
              </label>
              <Button
                type="button"
                size="sm"
                className="mt-2 w-full"
                disabled={pending || !customTime}
                onClick={() => void snoozeUntil(new Date(customTime))}
              >
                {pending ? "Snoozing…" : "Snooze until selected time"}
              </Button>
            </div>
            {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SnoozeChoice({
  label,
  detail,
  disabled,
  onClick,
}: {
  label: string;
  detail: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-foreground/[0.06] disabled:opacity-50"
    >
      <span>{label}</span>
      <span className="text-[11px] text-muted-foreground">{detail}</span>
    </button>
  );
}

function addHours(date: Date, hours: number): Date {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

function tomorrowMorning(): Date {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next;
}

function nextMondayMorning(): Date {
  const next = new Date();
  const days = ((8 - next.getDay()) % 7) || 7;
  next.setDate(next.getDate() + days);
  next.setHours(9, 0, 0, 0);
  return next;
}

function toDateTimeLocal(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
