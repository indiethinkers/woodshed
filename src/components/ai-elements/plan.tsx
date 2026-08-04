"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronsUpDown } from "lucide-react";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";
import { Shimmer } from "./shimmer";

const PlanContext = createContext({ isStreaming: false });

export type PlanProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
};

export function Plan({
  children,
  className,
  isStreaming = false,
  ...props
}: PlanProps) {
  const value = useMemo(() => ({ isStreaming }), [isStreaming]);
  return (
    <PlanContext.Provider value={value}>
      <Collapsible
        className={cn(
          "rounded-md border border-border/60 bg-background/55",
          className,
        )}
        {...props}
      >
        {children}
      </Collapsible>
    </PlanContext.Provider>
  );
}

export function PlanHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center justify-between gap-3 px-3 py-2", className)}
      {...props}
    />
  );
}

type PlanTitleProps = Omit<ComponentProps<"div">, "children"> & {
  children: string;
};

export function PlanTitle({ children, className, ...props }: PlanTitleProps) {
  const { isStreaming } = useContext(PlanContext);
  return (
    <div className={cn("text-[12.5px] font-medium", className)} {...props}>
      {isStreaming ? <Shimmer as="span">{children}</Shimmer> : children}
    </div>
  );
}

export function PlanDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("text-[11px] text-muted-foreground", className)} {...props} />
  );
}

export function PlanTrigger({ className, ...props }: ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      aria-label="Toggle plan"
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
      {...props}
    >
      <ChevronsUpDown className="size-3.5" />
    </CollapsibleTrigger>
  );
}

export function PlanContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={cn("border-t border-border/50 px-3 py-2", className)}
      {...props}
    />
  );
}
