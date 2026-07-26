import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { SlashCommandItem } from "./extensions/slash-command";

export interface SlashCommandMenuState {
  items: SlashCommandItem[];
  query: string;
  command: (item: SlashCommandItem) => void;
  clientRect: (() => DOMRect | null) | null;
}

export interface SlashCommandMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface Props {
  state: SlashCommandMenuState;
}

/**
 * Notion-style slash-command menu. Anchored to the caret via the
 * `clientRect` callback from `@tiptap/suggestion`. Keyboard navigation
 * (↑ / ↓ / Enter / Escape) is exposed via an imperative ref so the
 * suggestion plugin can forward keys before ProseMirror sees them.
 */
export const SlashCommandMenu = forwardRef<SlashCommandMenuHandle, Props>(
  function SlashCommandMenu({ state }, ref) {
    const [selected, setSelected] = useState(0);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    // Reset selection whenever the filtered list changes shape so the
    // highlight doesn't end up out of bounds.
    useEffect(() => {
      setSelected((prev) => (prev >= state.items.length ? 0 : prev));
    }, [state.items.length]);

    useEffect(() => {
      setSelected(0);
    }, [state.query]);

    // Position the menu relative to the caret. We re-read the rect on every
    // render — `clientRect` is cheap and the caret moves on every keystroke.
    // Default below the caret, but flip above the current line when there
    // isn't room below (caret near the bottom of the viewport) so the menu
    // stays on-screen.
    useLayoutEffect(() => {
      if (!state.clientRect) return;
      const rect = state.clientRect();
      if (!rect) return;
      const gap = 6;
      const menuHeight = menuRef.current?.offsetHeight ?? 0;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openAbove =
        spaceBelow < menuHeight + gap && rect.top > menuHeight + gap;
      const top = openAbove
        ? rect.top - gap - menuHeight
        : rect.bottom + gap;
      setPos({ top, left: rect.left });
    }, [state]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event) => {
        if (event.key === "ArrowUp") {
          setSelected(
            (prev) =>
              (prev - 1 + state.items.length) % Math.max(state.items.length, 1),
          );
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelected((prev) => (prev + 1) % Math.max(state.items.length, 1));
          return true;
        }
        if (event.key === "Enter") {
          const item = state.items[selected];
          if (item) {
            state.command(item);
            return true;
          }
          return false;
        }
        return false;
      },
    }));

    if (typeof document === "undefined") return null;
    if (!state.clientRect) return null;

    return createPortal(
      <div
        ref={menuRef}
        data-slash-command-menu
        style={{
          position: "fixed",
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          zIndex: 50,
          // Render hidden until measured so we can flip above the caret
          // without a flash at the wrong position.
          visibility: pos ? "visible" : "hidden",
        }}
        className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-1 min-w-[280px] max-h-80 overflow-y-auto"
      >
        <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          {state.items.length === 0 ? "No matches" : "Filtered results"}
        </div>
        {state.items.map((item, i) => {
          const Icon = item.icon;
          const isActive = i === selected;
          return (
            <button
              key={item.id}
              type="button"
              data-active={isActive ? "true" : undefined}
              className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 transition-colors ${
                isActive
                  ? "bg-foreground/[0.06] text-foreground"
                  : "hover:bg-foreground/[0.04]"
              }`}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => {
                // Prevent the editor from blurring before the command runs.
                e.preventDefault();
              }}
              onClick={() => state.command(item)}
            >
              <span className="inline-flex items-center justify-center h-7 w-7 rounded border border-border bg-background text-muted-foreground shrink-0">
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
              <span className="flex flex-col min-w-0">
                <span className="truncate">{item.title}</span>
                {item.description ? (
                  <span className="text-xs text-muted-foreground truncate">
                    {item.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
        <div className="mt-1 pt-1 border-t border-border flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
          <span>Close menu</span>
          <kbd className="font-mono text-[10px] bg-muted/60 border border-border rounded px-1.5 py-0.5">
            esc
          </kbd>
        </div>
      </div>,
      document.body,
    );
  },
);
