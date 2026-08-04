import { useEffect } from "react";
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import {
  Users,
  Bot,
  Calendar,
  Mail,
  NotebookPen,
  Database,
  Library,
  Layers,
  Settings,
} from "lucide-react";
import { BrandMark } from "@/components/shared/brand-mark";
import { mainNavShortcutIndex } from "./main-nav-shortcut";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { useTabs } from "./tabs-context-internal";
import { IndexingIndicator } from "./indexing-indicator";
import { cn } from "@/lib/utils";
import { useHasUnreadMail } from "@/lib/hooks/use-mail";

// Per-icon optical sizing: lucide glyphs sit on equal 32px boxes, but dense/
// boxy marks (Calendar, Database) read larger than thin/sparse ones (Bot,
// Library) at the same size. Nudging the glyph size — not the box — evens out
// their *perceived* weight. `iconClass` overrides the 16px default.
const navItems = [
  { label: "Cadence", href: "/", icon: Calendar, iconClass: "size-[15px]" },
  { label: "Mail", href: "/mail", icon: Mail, iconClass: "size-4" },
  // Bot's solid head sits low (thin antenna up top), so its mass reads ~1.5px
  // below center — nudge up to even the gaps with its neighbors.
  { label: "Agent", href: "/agent", icon: Bot, iconClass: "size-[17px] -translate-y-[1.5px]" },
  { label: "Notebook", href: "/notebook", icon: NotebookPen, iconClass: "size-4" },
  { label: "Resources", href: "/resources", icon: Library, iconClass: "size-[17px]" },
  { label: "People", href: "/people", icon: Users, iconClass: "size-[17px]" },
  { label: "Databases", href: "/databases", icon: Database, iconClass: "size-[15px]" },
  { label: "Areas", href: "/areas", icon: Layers, iconClass: "size-[17px]" },
] as const;

const railButtonClass =
  "relative h-8 w-8 rounded-lg flex items-center justify-center transition-colors";
const railIconClass = "h-4 w-4";

export function Sidebar({
  visuallyHidden = false,
  mailReady = false,
}: {
  visuallyHidden?: boolean;
  mailReady?: boolean;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { cycleTab, goBack, goForward } = useTabs();
  const hasUnreadMail = useHasUnreadMail(mailReady);

  // Global app shortcuts that should override browser defaults.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.altKey) return;

      // Cmd is held, so none of these shortcuts could be intercepted as a
      // text-input keystroke — fire regardless of focus, so tab cycling
      // and history controls are always available even with the editor focused.

      // ⌘1…⌘8 — jump to the main sidebar surfaces in visible order.
      const navIndex = mainNavShortcutIndex(e);
      if (navIndex !== null) {
        const item = navItems[navIndex];
        if (item) {
          e.preventDefault();
          void navigate({ to: item.href, viewTransition: true });
        }
        return;
      }

      // ⌘⇧[ / ⌘⇧] — cycle through open tabs (Safari/Chrome convention).
      // Match on `e.code` because Shift mutates `e.key` to "{"/"}" and the
      // exact character varies across keyboard layouts.
      if (
        e.shiftKey &&
        (e.code === "BracketLeft" || e.code === "BracketRight")
      ) {
        e.preventDefault();
        const delta = e.code === "BracketLeft" ? -1 : 1;
        cycleTab(delta);
        return;
      }

      // ⌘[ / ⌘] — browser-style back/forward, but scoped to the active
      // tab's private history stack so each tab feels like its own
      // browser tab. ⌘⇧[ / ⌘⇧] (handled above) stays the cross-tab cycle.
      if (!e.shiftKey && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        if (e.key === "[") goBack();
        else goForward();
        return;
      }

      // ⌘, — settings
      if (!e.shiftKey && e.key === ",") {
        e.preventDefault();
        void navigate({ to: "/settings", viewTransition: true });
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [navigate, cycleTab, goBack, goForward]);

  // Sidebar Link clicks ride TanStack Router's built-in `viewTransition`
  // prop for a hardware-accelerated crossfade between sections. Earlier
  // we wrapped navigate() in document.startViewTransition ourselves; the
  // browser then awaited navigate()'s Promise and a single slow loader
  // could lock out every subsequent click. Letting the router drive the
  // transition fixes that — it commits the location, applies the
  // animation, and never strands the transition on a pending Promise.

  return (
    <TooltipProvider>
      <aside
        aria-hidden={visuallyHidden}
        data-sidebar-rail
        data-woodshed-surface="nav"
        className={cn(
          "h-full w-[52px] shrink-0 flex-col items-center gap-1 border-r border-border bg-rail py-3",
          visuallyHidden ? "hidden" : "flex",
        )}
      >
        {/* Brand mark */}
        <Link to="/" viewTransition className="mb-1 block" aria-label="Woodshed home">
          <BrandMark className="h-10 w-10 text-foreground" title="Woodshed" />
        </Link>

        {/* Nav icons */}
        <nav className="flex flex-col items-center gap-1 flex-1">
          {navItems.map((item, index) => {
            // Cadence lives at "/" but also owns /cadence/*; other items
            // use a normal prefix match.
            const isActive =
              item.href === "/"
                ? pathname === "/" || pathname.startsWith("/cadence")
                : pathname === item.href ||
                  pathname.startsWith(item.href + "/");
            const showsUnreadMail = item.href === "/mail" && hasUnreadMail;

            return (
              <Tooltip key={item.href}>
                <TooltipTrigger
                  render={
                    <Link
                      to={item.href}
                      viewTransition
                      aria-label={
                        showsUnreadMail
                          ? `${item.label}, unread messages`
                          : item.label
                      }
                      data-unread={showsUnreadMail ? "true" : undefined}
                      data-woodshed-action={`navigate:${item.label.toLowerCase()}`}
                      className={cn(
                        railButtonClass,
                        isActive && "bg-muted-foreground/15",
                        showsUnreadMail
                          ? "text-blue-500 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-400"
                          : isActive
                            ? "text-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-accent",
                      )}
                    />
                  }
                >
                  <item.icon className={item.iconClass} />
                  {showsUnreadMail && (
                    <span
                      aria-hidden="true"
                      data-unread-indicator
                      className="absolute right-1 top-1 size-1.5 rounded-full bg-blue-500 ring-2 ring-rail dark:bg-blue-400"
                    />
                  )}
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  <span className="inline-flex items-center gap-2">
                    {item.label}
                    <kbd className="inline-flex h-4 items-center rounded border border-background/25 bg-background/15 px-1 text-[10px] font-medium text-background">
                      ⌘{index + 1}
                    </kbd>
                  </span>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        {/* Utility actions, anchored above the settings gear. */}
        <div className="w-full flex flex-col items-center gap-1">
          <IndexingIndicator />
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  to="/settings"
                  viewTransition
                  aria-label="Settings"
                  data-woodshed-action="navigate:settings"
                  className={`${railButtonClass} ${
                    pathname.startsWith("/settings")
                      ? "bg-muted-foreground/15 text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                />
              }
            >
              <Settings className={railIconClass} />
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              <span className="inline-flex items-center gap-2">
                Settings
                <kbd className="inline-flex items-center px-1 h-4 rounded text-[10px] font-medium bg-background/15 border border-background/25 text-background">
                  ⌘,
                </kbd>
              </span>
            </TooltipContent>
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}
