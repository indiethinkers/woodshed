"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  viewportProps,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  viewportProps?: React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>;
}) {
  const { className: viewportClassName, ...viewportRest } = viewportProps ?? {};
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        // No focus ring on the viewport itself: Base UI makes it focusable
        // for keyboard-scroll, and the default `ring-[3px]` paints OUTWARD
        // from the viewport, bleeding 3px into adjacent panes (the boundary
        // between adjacent panes visibly thickens when focus lands here).
        // Real focus indicators live on the interactive
        // elements inside (row cursor bars, button rings) — those are the
        // meaningful focus targets, not the scroll surface.
        //
        // Hide the native scrollbar: Base UI's Viewport sets `overflow: scroll`
        // inline so the native scrollbar is always reserved/painted, then
        // overlays its own custom scrollbar on top. Without these rules the
        // native scrollbar leaks through whenever it doesn't auto-hide
        // (macOS "Always show", external mouse, Windows/Linux WKWebView),
        // showing as a thin track even when content fits.
        className={cn(
          "size-full rounded-[inherit] outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          viewportClassName,
        )}
        {...viewportRest}
      >
        {/* Content is what attaches a ResizeObserver to the inner content,
            so the scrollbar recomputes when the content height changes (not
            just when the viewport resizes). Without it, navigating from a
            day with many tasks to one with few leaves the scrollbar
            visible until the user touches the panel. Base UI's default
            inline `min-width: fit-content` would force long unbreakable
            children (URLs in notes) to overflow horizontally — neutralize
            with min-w-0. */}
        <ScrollAreaPrimitive.Content style={{ minWidth: 0 }}>
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  // Hidden by default; appears only while the user is actively scrolling
  // (`data-scrolling`). Hover alone should not add visual noise to quiet
  // panes. 150ms opacity transition keeps the fade quiet — long enough
  // to read as intentional, short enough not to lag a flick scroll.
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px select-none transition-opacity duration-150 opacity-0 data-scrolling:opacity-100 data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
