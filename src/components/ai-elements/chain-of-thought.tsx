"use client";

import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Check, ChevronRight, Circle, Loader2, X } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Shimmer } from "./shimmer";

export type ChainOfThoughtStatus = "complete" | "active" | "pending" | "error";

interface ChainOfThoughtContextValue {
  active: boolean;
  durationSeconds: number | null;
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(
  null,
);

function useChainOfThought(): ChainOfThoughtContextValue {
  const context = useContext(ChainOfThoughtContext);
  if (!context) {
    throw new Error(
      "ChainOfThought subcomponents must be used within <ChainOfThought>",
    );
  }
  return context;
}

export type ChainOfThoughtProps = Omit<
  ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange" | "defaultOpen"
> & {
  /** While true: the panel auto-opens and the header reads "…is working". */
  active: boolean;
};

/**
 * A live activity log for an agent turn. While `active`, it auto-expands and
 * shows a running timer; once the turn settles it freezes the elapsed time and
 * gently collapses into a re-expandable "Worked for Ns" summary. Monochrome and
 * built from theme tokens to match the app's no-chromatic commitment.
 */
export function ChainOfThought({
  active,
  className,
  children,
  ...props
}: ChainOfThoughtProps) {
  const [open, setOpen] = useState(active);
  const userToggledRef = useRef(false);
  const startedAtRef = useRef<number | null>(active ? Date.now() : null);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (active) {
      if (startedAtRef.current === null) startedAtRef.current = Date.now();
      if (!userToggledRef.current) setOpen(true);
      return;
    }
    if (startedAtRef.current !== null) {
      const elapsed = Math.max(
        1,
        Math.round((Date.now() - startedAtRef.current) / 1000),
      );
      setDurationSeconds(elapsed);
      startedAtRef.current = null;
    }
    if (userToggledRef.current) return;
    // Let the final step register before folding away.
    const timer = window.setTimeout(() => setOpen(false), 600);
    return () => window.clearTimeout(timer);
  }, [active]);

  return (
    <ChainOfThoughtContext.Provider value={{ active, durationSeconds }}>
      <Collapsible
        className={cn("not-prose", className)}
        onOpenChange={(next) => {
          userToggledRef.current = true;
          setOpen(next);
        }}
        open={open}
        {...props}
      >
        {children}
      </Collapsible>
    </ChainOfThoughtContext.Provider>
  );
}

export type ChainOfThoughtHeaderProps = Omit<
  ComponentProps<typeof CollapsibleTrigger>,
  "children"
> & {
  displayName?: string;
  activeLabel?: string;
  stepCount?: number;
};

export function ChainOfThoughtHeader({
  className,
  displayName = "Cadence",
  activeLabel,
  stepCount,
  ...props
}: ChainOfThoughtHeaderProps) {
  const { active, durationSeconds } = useChainOfThought();
  const elapsed = useLiveElapsed(active);

  return (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full items-center gap-1.5 text-left outline-none",
        className,
      )}
      {...props}
    >
      <ChevronRight
        className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-data-[panel-open]:rotate-90"
        strokeWidth={2}
      />
      {active ? (
        <Shimmer
          as="span"
          className="text-[13px] font-medium"
          duration={1.3}
          spread={1.4}
        >
          {activeLabel ?? `${displayName} is working`}
        </Shimmer>
      ) : (
        <span className="text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          {summaryLabel(durationSeconds, stepCount)}
        </span>
      )}
      {active && (
        <span className="tabular-nums text-[12px] text-muted-foreground/65">
          {formatChainElapsed(elapsed)}
        </span>
      )}
    </CollapsibleTrigger>
  );
}

export type ChainOfThoughtContentProps = ComponentProps<
  typeof CollapsibleContent
>;

export function ChainOfThoughtContent({
  className,
  children,
  ...props
}: ChainOfThoughtContentProps) {
  return (
    <CollapsibleContent
      className={cn(
        "outline-none data-closed:animate-out data-open:animate-in data-closed:fade-out-0 data-open:fade-in-0",
        className,
      )}
      {...props}
    >
      <div className="mt-2.5 space-y-2 pl-[3px]">{children}</div>
    </CollapsibleContent>
  );
}

export type ChainOfThoughtStepProps = ComponentProps<"div"> & {
  status?: ChainOfThoughtStatus;
  label: ReactNode;
  description?: ReactNode;
};

export function ChainOfThoughtStep({
  status = "pending",
  label,
  description,
  className,
  children,
  ...props
}: ChainOfThoughtStepProps) {
  return (
    <div className={cn("flex items-start gap-2.5", className)} {...props}>
      <span className="mt-[2px] flex size-3.5 shrink-0 items-center justify-center">
        <ChainStatusIcon status={status} />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-[13px] leading-5",
            status === "active" ? "text-foreground" : "text-foreground/80",
            status === "pending" && "text-muted-foreground/70",
          )}
        >
          {label}
        </div>
        {description && (
          <div className="mt-0.5 text-[12px] leading-4 text-muted-foreground/70">
            {description}
          </div>
        )}
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </div>
  );
}

function ChainStatusIcon({ status }: { status: ChainOfThoughtStatus }) {
  if (status === "active") {
    return (
      <Loader2
        className="size-3.5 animate-spin text-foreground/70"
        strokeWidth={2.2}
      />
    );
  }
  if (status === "complete") {
    return <Check className="size-3 text-muted-foreground/65" strokeWidth={2.6} />;
  }
  if (status === "error") {
    return <X className="size-3 text-destructive/80" strokeWidth={2.6} />;
  }
  return <Circle className="size-2.5 text-muted-foreground/40" strokeWidth={2.4} />;
}

function summaryLabel(durationSeconds: number | null, stepCount?: number): string {
  const steps =
    typeof stepCount === "number" && stepCount > 0
      ? `${stepCount} ${stepCount === 1 ? "step" : "steps"}`
      : null;
  if (durationSeconds != null) {
    const worked = `Worked for ${formatChainElapsed(durationSeconds)}`;
    return steps ? `${worked} · ${steps}` : worked;
  }
  return steps ?? "Show work";
}

function formatChainElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function useLiveElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  return elapsed;
}
