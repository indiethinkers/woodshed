"use client";

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";

export interface ContextTokenUsage {
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

interface ContextValue {
  usage: ContextTokenUsage;
}

const TokenContext = createContext<ContextValue | null>(null);

function useTokenContext(): ContextValue {
  const context = useContext(TokenContext);
  if (!context) throw new Error("Context components must be used within Context");
  return context;
}

export type ContextProps = ComponentProps<typeof HoverCard> & {
  usage: ContextTokenUsage;
};

export function Context({ usage, ...props }: ContextProps) {
  const value = useMemo(() => ({ usage }), [usage]);
  return (
    <TokenContext.Provider value={value}>
      <HoverCard {...props} />
    </TokenContext.Provider>
  );
}

export type ContextTriggerProps = ComponentProps<"button">;

export function ContextTrigger({ className, ...props }: ContextTriggerProps) {
  return (
    <HoverCardTrigger
      render={
        <button
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] tabular-nums text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/20",
            className,
          )}
          type="button"
          {...props}
        />
      }
    />
  );
}

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export function ContextContent({ className, ...props }: ContextContentProps) {
  return (
    <HoverCardContent
      align="end"
      className={cn("w-60 space-y-2.5 p-3", className)}
      {...props}
    />
  );
}

export function ContextUsageBreakdown() {
  const { usage } = useTokenContext();
  const rows = [
    ["Input", usage.inputTokens],
    ["Output", usage.outputTokens],
    ["Reasoning", usage.reasoningTokens],
    ["Cached input", usage.cachedInputTokens],
  ] as const;
  return (
    <div className="space-y-1.5 text-[12px]">
      <div className="flex items-center justify-between border-b border-border/60 pb-2 font-medium text-foreground">
        <span>Context usage</span>
        <span className="font-mono tabular-nums">
          {formatTokens(usage.totalTokens ?? totalFromUsage(usage))}
        </span>
      </div>
      {rows.map(([label, value]) =>
        value === undefined ? null : (
          <div className="flex items-center justify-between" key={label}>
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono tabular-nums text-foreground/80">
              {formatTokens(value)}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

export function totalFromUsage(usage: ContextTokenUsage): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}
