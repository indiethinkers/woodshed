import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function DaybookSectionHeader({
  label,
  right,
  className,
}: {
  label: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-6",
        className,
      )}
    >
      <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </h2>
      <div className="h-px bg-border" aria-hidden />
      <div className="min-w-[72px] text-right font-mono text-[13px] text-muted-foreground">
        {right}
      </div>
    </div>
  );
}
