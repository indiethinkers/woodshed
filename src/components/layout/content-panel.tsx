import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Topbar } from "./topbar";
import {
  FilePathDock,
  FilePathProvider,
} from "@/components/shared/file-path-pill";
import { useTabs } from "./tabs-context-internal";
import {
  consumeContentScrollRestore,
  rememberContentScroll,
} from "@/lib/content-scroll-memory";
import { tabPath } from "./tabs-context-internal";
import { cn } from "@/lib/utils";

/** Dispatch on `window` to re-pin a `pinToBottom` ContentPanel to the bottom
 *  of its scroll — a stream-style page fires this after appending content so
 *  the newest item always scrolls into view. */
export const CONTENT_SCROLL_BOTTOM_EVENT = "woodshed:content-scroll-bottom";

/** Riding-the-bottom tolerance: within this distance of the end, content
 *  growth keeps the view pinned to the newest content; scrolling up past it
 *  releases the pin so reading older notes isn't interrupted. */
const PIN_THRESHOLD_PX = 64;

/** Remembered in place of a px offset when the user leaves a pinned page at
 *  the bottom. A raw offset would go stale — the editor re-hydrates to a
 *  different height on return — so we remember "was at the bottom" instead
 *  and re-pin. scrollTo clamps it, so it's also a valid restore target. */
const BOTTOM_SENTINEL = Number.MAX_SAFE_INTEGER;

export function ContentPanel({
  children,
  wide = false,
  filePath,
  showTopbar = true,
  footer,
  pinToBottom = false,
  flush = false,
  comfortable = false,
}: {
  children: React.ReactNode;
  /** Skip the centered Cadence-width column. Use for table-heavy views that need
   *  the full panel width. */
  wide?: boolean;
  /** Source-of-truth file path (or pseudo-path) for the page. Rendered as a
   *  persistent dock at the bottom-right of the content panel. */
  filePath?: string;
  /** Daily Cadence owns its own editorial date/navigation header. */
  showTopbar?: boolean;
  /** Floats over the bottom of the scroll area, in the same centered column
   *  as content — e.g. the Mail triage command bar. Content scrolls
   *  beneath it; the scroll content gets clearance padding so the last
   *  line can always rise above the bar. */
  footer?: React.ReactNode;
  /** Journal-style scroll: when restored at the bottom, the page rides
   *  content growth — lazy editor hydration, a capture landing — until
   *  the user scrolls up. */
  pinToBottom?: boolean;
  /** Remove the default content gutters for intentionally full-bleed views. */
  flush?: boolean;
  /** Reading-pane surfaces (mail detail): extra vertical inset so the
   *  document doesn't crowd the viewport's top and bottom edges. */
  comfortable?: boolean;
}) {
  const href = useRouterState({ select: (s) => s.location.href });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { activeId, tabs } = useTabs();
  const activeTabHref = useMemo(() => {
    const activeTab = tabs.find((tab) => tab.id === activeId);
    return activeTab ? tabPath(activeTab) : null;
  }, [activeId, tabs]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const renderTopbar = showTopbar;
  const semantic = useMemo(
    () => semanticContext(pathname, filePath),
    [pathname, filePath],
  );

  const contentRef = useRef<HTMLDivElement | null>(null);
  // Whether the view is currently riding the bottom of the stream. Only
  // meaningful when `pinToBottom` is set.
  const pinnedRef = useRef(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (activeTabHref !== null && activeTabHref !== href) return;

    const restoredTop = consumeContentScrollRestore(activeId, href);
    // Cadence pages open at the bottom (newest notes). Pin when there's no
    // remembered scroll — a fresh open or a navigation to another day — or
    // when the user previously left this page riding the bottom. A remembered
    // finite offset (scrolled up, then switched tabs) is still honored so
    // tab-switching doesn't lose the reader's place.
    const pinned =
      pinToBottom && (restoredTop == null || restoredTop >= BOTTOM_SENTINEL);
    pinnedRef.current = pinned;
    const nextTop = restoredTop ?? 0;

    // Arrow (not a hoisted function declaration) so the `!viewport` guard's
    // narrowing applies inside the closure.
    const applyScroll = () => {
      // While pinned, read scrollHeight at call time — content is still
      // hydrating during these first frames and the height keeps moving.
      viewport.scrollTo({
        top: pinned ? viewport.scrollHeight : nextTop,
        left: 0,
      });
    };

    applyScroll();
    const raf = window.requestAnimationFrame(applyScroll);

    // Late-load scroll guard. A freshly opened page with a tall embed can be
    // yanked downward when the embed's iframe scrolls itself into view a few
    // hundred ms after mount (WebKit). Until the user actually scrolls — or a
    // short settle window passes — snap any non-user scroll back to the
    // intended position (top on a fresh open; the remembered offset for
    // back/forward). Journal pages (pinToBottom) run their own snap loop, so
    // they're left alone.
    let settleTimer = 0;
    let teardownGuard: (() => void) | null = null;
    if (!pinToBottom) {
      let released = false;
      const intentOpts = { passive: true, capture: true } as const;
      const onUserIntent = () => {
        released = true;
      };
      const onScroll = () => {
        // A user scroll fires its intent event (wheel/pointer/key/touch) first,
        // flipping `released`; anything else moving the viewport in this window
        // is programmatic (the embed) and gets snapped back.
        if (released) return;
        if (Math.abs(viewport.scrollTop - nextTop) > 1) {
          viewport.scrollTo({ top: nextTop, left: 0 });
        }
      };
      viewport.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("wheel", onUserIntent, intentOpts);
      window.addEventListener("touchstart", onUserIntent, intentOpts);
      window.addEventListener("pointerdown", onUserIntent, intentOpts);
      window.addEventListener("keydown", onUserIntent, { capture: true });
      settleTimer = window.setTimeout(() => {
        released = true;
      }, 1500);
      teardownGuard = () => {
        viewport.removeEventListener("scroll", onScroll);
        window.removeEventListener("wheel", onUserIntent, { capture: true });
        window.removeEventListener("touchstart", onUserIntent, { capture: true });
        window.removeEventListener("pointerdown", onUserIntent, { capture: true });
        window.removeEventListener("keydown", onUserIntent, { capture: true });
      };
    }

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
      teardownGuard?.();
      rememberContentScroll(
        activeId,
        href,
        pinToBottom && pinnedRef.current ? BOTTOM_SENTINEL : viewport.scrollTop,
      );
    };
  }, [activeId, activeTabHref, href, pinToBottom]);

  // Bottom-pinning for journal pages: while the user is at (or near) the
  // end, any content growth — the lazy editor mounting, a capture landing,
  // an embed loading — re-anchors the view to the newest content. Scrolling
  // up releases the pin; scrolling back down re-engages it.
  useEffect(() => {
    if (!pinToBottom) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const snap = () => {
      if (pinnedRef.current) viewport.scrollTop = viewport.scrollHeight;
    };
    const observer = new ResizeObserver(snap);
    observer.observe(viewport);
    if (contentRef.current) observer.observe(contentRef.current);

    const onScroll = () => {
      pinnedRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
        PIN_THRESHOLD_PX;
    };
    const onPinRequest = () => {
      pinnedRef.current = true;
      // Instant, not smooth: a smooth scroll passes through positions far
      // from the bottom, and the scroll listener above would read those as
      // the user scrolling away and release the pin mid-flight.
      viewport.scrollTop = viewport.scrollHeight;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener(CONTENT_SCROLL_BOTTOM_EVENT, onPinRequest);
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      window.removeEventListener(CONTENT_SCROLL_BOTTOM_EVENT, onPinRequest);
    };
  }, [pinToBottom]);

  return (
    // `min-h-0` is critical: as a flex item, ContentPanel's default
    // `min-height: auto` lets it grow to its content's intrinsic height,
    // which makes the inner ScrollArea match content height (no scroll
    // ever fires). `min-h-0` lets `h-full` actually cap the panel and
    // forces the ScrollArea to clip + scroll.
    <div
      className="relative flex-1 h-full min-h-0 min-w-0 flex flex-col bg-content"
      data-woodshed-content-panel=""
      data-woodshed-surface={semantic.surface}
      data-woodshed-record-type={semantic.recordType}
      data-woodshed-record-id={semantic.recordId}
      data-woodshed-path={filePath}
    >
      <FilePathProvider path={filePath}>
        {renderTopbar && <Topbar wide={wide} />}
        <ScrollArea
          className="flex-1 min-h-0"
          // Base UI's Viewport props type omits React's `data-*` index
          // signature, so the marker attribute is passed via a typed spread
          // (consumed by the scroll-restore helpers that query the viewport).
          viewportProps={{
            ...({
              "data-woodshed-content-scroll": "",
            } as Record<`data-${string}`, string>),
            ref: viewportRef,
          }}
        >
          <div
            ref={contentRef}
            className={cn(
              "text-base lg:text-[17px] xl:text-[18px]",
              flush ? "px-0 pt-0" : "px-10",
              // With a Topbar, the breadcrumb→title gap is split: the Topbar's
              // pb-4 (16px) gives scroll clearance under the breadcrumb, and
              // pt-6 (24px) here adds the rest — 40px total at first paint, so
              // the large detail-page title doesn't crowd the sticky breadcrumb.
              // Without a Topbar (Cadence/mail own their headers) pt-4 stands.
              !flush && (renderTopbar ? "pt-6" : comfortable ? "pt-10" : "pt-4"),
              // With a floating footer, the last line of content needs to be
              // able to scroll clear of the bar.
              flush ? "pb-0" : footer ? "pb-32" : comfortable ? "pb-12" : "pb-8",
            )}
          >
            {wide ? children : (
              <div className="max-w-detail mx-auto w-full">{children}</div>
            )}
          </div>
        </ScrollArea>
        {footer && (
          // Floating overlay: the bar paints above the scroll area and
          // content slides beneath it. The fade keeps text readable as it
          // passes under the composer without turning the bottom into a
          // separate fixed panel.
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
            <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-content via-content/80 to-content/0" />
            <div className="relative px-10 pb-5">
              <div className="pointer-events-auto max-w-detail mx-auto w-full">
                {footer}
              </div>
            </div>
          </div>
        )}
        {/* After the footer in DOM but absolutely positioned against the
            panel root — the dock keeps the same bottom-right spot on every
            page whether or not a capture bar is present. */}
        <FilePathDock />
      </FilePathProvider>
    </div>
  );
}

function semanticContext(pathname: string, filePath?: string) {
  const segments = pathname.split("/").filter(Boolean);
  let surface = segments[0] ?? "cadence";
  if (pathname === "/" || surface === "cadence") surface = "cadence";

  let recordType: string | undefined;
  let recordId: string | undefined;
  if (filePath) {
    const [section, leaf] = filePath.split("/");
    recordId = leaf?.replace(/\.md$/, "");
    recordType =
      section === "cadence"
        ? "daily"
        : section === "events"
          ? "event"
          : section === "notebook"
            ? "note"
            : section === "people"
              ? "person"
                : section === "resources"
                  ? "resource"
                  : section === "tasks"
                    ? "task"
                    : section === "areas"
                      ? "area"
                      : undefined;
  }
  return { surface, recordType, recordId };
}
