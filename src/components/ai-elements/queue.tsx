"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export type QueueProps = ComponentProps<"div">;

export function Queue({ className, ...props }: QueueProps) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-border/60 bg-muted/15",
        className,
      )}
      {...props}
    />
  );
}

export type QueueSectionProps = ComponentProps<typeof Collapsible>;

export function QueueSection({
  className,
  defaultOpen = false,
  ...props
}: QueueSectionProps) {
  return (
    <Collapsible className={className} defaultOpen={defaultOpen} {...props} />
  );
}

export type QueueSectionTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
>;

export function QueueSectionTrigger({
  className,
  ...props
}: QueueSectionTriggerProps) {
  return (
    <CollapsibleTrigger
      className={cn(
        "group flex min-h-8 w-full items-center justify-between px-3 py-1.5 text-left text-[12px] text-muted-foreground outline-none transition-colors hover:bg-muted/35 hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function QueueSectionLabel({
  className,
  count,
  icon,
  label,
  ...props
}: ComponentProps<"span"> & {
  count: number;
  icon?: ReactNode;
  label: string;
}) {
  return (
    <span className={cn("flex items-center gap-2", className)} {...props}>
      <ChevronDown className="size-3.5 transition-transform group-data-closed:-rotate-90" />
      {icon}
      <span>{`${count} ${label}`}</span>
    </span>
  );
}

export type QueueSectionContentProps = ComponentProps<
  typeof CollapsibleContent
>;

export function QueueSectionContent(props: QueueSectionContentProps) {
  return <CollapsibleContent {...props} />;
}

export type QueueListProps = ComponentProps<typeof ScrollArea>;

export function QueueList({ children, className, ...props }: QueueListProps) {
  return (
    <ScrollArea className={cn("max-h-40", className)} {...props}>
      <ul className="border-t border-border/50 py-1">{children}</ul>
    </ScrollArea>
  );
}

export type QueueItemProps = ComponentProps<"li">;

export function QueueItem({ className, ...props }: QueueItemProps) {
  return (
    <li
      className={cn(
        "group flex min-w-0 items-center gap-2 px-3 py-1.5 text-[12px]",
        className,
      )}
      {...props}
    />
  );
}

export function QueueItemIndicator({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/65",
        className,
      )}
      {...props}
    />
  );
}

export function QueueItemContent({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      className={cn("min-w-0 flex-1 truncate text-foreground/80", className)}
      {...props}
    />
  );
}
