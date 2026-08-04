"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Brain, ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MessageResponse } from "./message";
import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
  duration: number | undefined;
  isOpen: boolean;
  isStreaming: boolean;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

function useReasoning(): ReasoningContextValue {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
}

export type ReasoningProps = Omit<
  ComponentProps<typeof Collapsible>,
  "open" | "defaultOpen" | "onOpenChange"
> & {
  defaultOpen?: boolean;
  duration?: number;
  isStreaming?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
};

export const Reasoning = memo(function Reasoning({
  children,
  className,
  defaultOpen,
  duration: durationProp,
  isStreaming = false,
  onOpenChange,
  open,
  ...props
}: ReasoningProps) {
  const controlled = open !== undefined;
  const explicitlyClosed = defaultOpen === false;
  const [internalOpen, setInternalOpen] = useState(
    defaultOpen ?? isStreaming,
  );
  const [duration, setDuration] = useState<number | undefined>(durationProp);
  const isOpen = controlled ? open : internalOpen;
  const startedAtRef = useRef<number | null>(isStreaming ? Date.now() : null);
  const streamedRef = useRef(isStreaming);
  const autoClosedRef = useRef(false);

  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  useEffect(() => {
    if (durationProp !== undefined) setDuration(durationProp);
  }, [durationProp]);

  useEffect(() => {
    if (isStreaming) {
      streamedRef.current = true;
      autoClosedRef.current = false;
      if (startedAtRef.current === null) startedAtRef.current = Date.now();
      if (!isOpen && !explicitlyClosed) setOpen(true);
      return;
    }
    if (startedAtRef.current !== null) {
      setDuration(
        Math.max(1, Math.ceil((Date.now() - startedAtRef.current) / 1000)),
      );
      startedAtRef.current = null;
    }
    if (!streamedRef.current || !isOpen || autoClosedRef.current) return;
    const timer = window.setTimeout(() => {
      autoClosedRef.current = true;
      setOpen(false);
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [explicitlyClosed, isOpen, isStreaming, setOpen]);

  const value = useMemo(
    () => ({ duration, isOpen, isStreaming }),
    [duration, isOpen, isStreaming],
  );

  return (
    <ReasoningContext.Provider value={value}>
      <Collapsible
        className={cn("not-prose", className)}
        onOpenChange={setOpen}
        open={isOpen}
        {...props}
      >
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  );
});

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (
    isStreaming: boolean,
    duration?: number,
  ) => ReactNode;
};

export const ReasoningTrigger = memo(function ReasoningTrigger({
  children,
  className,
  getThinkingMessage = defaultThinkingMessage,
  ...props
}: ReasoningTriggerProps) {
  const { duration, isOpen, isStreaming } = useReasoning();
  return (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full items-center gap-1.5 text-left text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <Brain className="size-3.5" strokeWidth={1.8} />
          {getThinkingMessage(isStreaming, duration)}
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform",
              isOpen && "rotate-180",
            )}
          />
        </>
      )}
    </CollapsibleTrigger>
  );
});

function defaultThinkingMessage(isStreaming: boolean, duration?: number) {
  if (isStreaming) {
    return (
      <Shimmer as="span" duration={1.2} spread={1.3}>
        Thinking through the response
      </Shimmer>
    );
  }
  return <span>{duration ? `Thought for ${duration}s` : "Reasoning"}</span>;
}

export type ReasoningContentProps = Omit<
  ComponentProps<typeof CollapsibleContent>,
  "children"
> & {
  children: string;
};

export const ReasoningContent = memo(function ReasoningContent({
  children,
  className,
  ...props
}: ReasoningContentProps) {
  const { isStreaming } = useReasoning();
  return (
    <CollapsibleContent
      className={cn(
        "mt-2.5 max-h-52 overflow-y-auto rounded-md border border-border/60 bg-muted/15 px-3 py-2 text-[12.5px] leading-5 text-muted-foreground outline-none data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0",
        className,
      )}
      {...props}
    >
      <MessageResponse
        isAnimating={isStreaming}
        mode={isStreaming ? "streaming" : "static"}
        parseIncompleteMarkdown={isStreaming}
      >
        {children}
      </MessageResponse>
    </CollapsibleContent>
  );
});

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
