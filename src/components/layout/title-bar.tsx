import { useCallback, useEffect, type CSSProperties } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Bot, ChevronDown, PanelLeft, Plus, X } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useListPanel } from "./list-panel-context-internal";
import { useAgentPanel } from "./agent-panel-context-internal";
import { canShowAgentPanel } from "./agent-panel-route";
import { isAgentPanelToggleShortcut } from "./agent-panel-shortcut";
import { isListPanelToggleShortcut } from "./list-panel-shortcut";
import { isEditableElement } from "@/lib/dom/is-editable";
import { useTabs, tabPath, type OpenTab } from "./tabs-context-internal";
import { TitleBarActions } from "./title-bar-actions";
import { useResolvedRouteTitle } from "@/lib/route-title";
import { supportsViewTransition } from "@/lib/view-transition";
import { useVaultPath } from "@/lib/hooks/use-vault-path";
import { isTauriRuntime } from "@/lib/runtime";
import { cn } from "@/lib/utils";

const RAIL_WIDTH = 52;
const LIST_PANEL_WIDTH = 300;
const DEFAULT_LEFT_CHROME_WIDTH = 320;
const LEFT_CONTROL_INSET = 96;

export function TitleBar() {
  const tauriRuntime = isTauriRuntime();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { collapsed, toggle } = useListPanel();
  const { open: agentOpen, toggle: toggleAgent } = useAgentPanel();
  const { tabs, activeId, closeTab, newTab, selectTab, reorderTabs } =
    useTabs();
  const hasListPanel = tauriRuntime && hasSurfaceListPanel(pathname);
  const canShowAgent = tauriRuntime && canShowAgentPanel(pathname);
  const hasVisiblePanel = hasListPanel || (canShowAgent && agentOpen);
  const leftChromeWidth = hasListPanel || canShowAgent
    ? RAIL_WIDTH + LIST_PANEL_WIDTH
    : DEFAULT_LEFT_CHROME_WIDTH;

  const handleAgentToggle = useCallback(() => {
    if (!agentOpen && collapsed) toggle();
    toggleAgent();
  }, [agentOpen, collapsed, toggle, toggleAgent]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (canShowAgent && isAgentPanelToggleShortcut(event)) {
        // Let ⌘B fall through to the editor's bold command when typing in a
        // text field / Tiptap editor — only toggle the agent panel otherwise.
        if (isEditableElement(event.target)) return;
        event.preventDefault();
        handleAgentToggle();
        return;
      }
      if (!hasVisiblePanel || !isListPanelToggleShortcut(event)) return;
      event.preventDefault();
      toggle();
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [canShowAgent, handleAgentToggle, hasVisiblePanel, toggle]);

  // 4px activation distance lets a quick click still register as a tab
  // selection — only sustained pointer moves start a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    reorderTabs(String(active.id), String(over.id));
  }

  return (
    <div
      data-tauri-drag-region
      className="relative flex h-[52px] shrink-0 items-center border-b border-border/70 bg-titlebar"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 z-10 w-px bg-border"
        style={{ left: leftChromeWidth - 1 }}
      />

      <ChromeControls
        collapsed={collapsed}
        canShowAgent={canShowAgent}
        agentOpen={agentOpen}
        hasListPanel={hasVisiblePanel}
        leftChromeWidth={leftChromeWidth}
        onAgentToggle={handleAgentToggle}
        onToggle={toggle}
        side="left"
      />

      <div
        data-tauri-drag-region
        className="mx-3 flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
      >
        <DndContext
          id="title-bar-tabs"
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={tabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div
              role="tablist"
              aria-label="Open tabs"
              className="flex min-w-0 shrink items-center gap-1 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {tabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeId}
                  onSelect={() => selectTab(tab.id)}
                  onClose={() => closeTab(tab.id)}
                  canClose={tabs.length > 1}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <button
          data-tauri-drag-region="false"
          type="button"
          onClick={newTab}
          title="New tab"
          aria-label="New tab"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <Plus className="h-4 w-4" strokeWidth={1.85} />
        </button>
      </div>

      <TitleBarActions />
    </div>
  );
}

function ChromeControls({
  agentOpen,
  canShowAgent,
  collapsed,
  hasListPanel,
  leftChromeWidth,
  onAgentToggle,
  onToggle,
  side,
}: {
  agentOpen: boolean;
  canShowAgent: boolean;
  collapsed: boolean;
  hasListPanel: boolean;
  leftChromeWidth: number;
  onAgentToggle: () => void;
  onToggle: () => void;
  side: "left" | "right";
}) {
  return (
    <div
      data-tauri-drag-region
      className={`flex shrink-0 items-center gap-2 self-stretch ${
        side === "right" ? "justify-end pl-3 pr-4" : "justify-start pr-3"
      }`}
      style={
        side === "right"
          ? { width: leftChromeWidth }
          : { width: leftChromeWidth, paddingLeft: LEFT_CONTROL_INSET }
      }
    >
      {side === "right" && <TitleBarActions />}
      <VaultPathControl compact={canShowAgent} />
      {canShowAgent && (
        <button
          data-tauri-drag-region="false"
          type="button"
          onClick={onAgentToggle}
          title={agentOpen ? "Close page chat (⌘B)" : "Chat about this page (⌘B)"}
          aria-label={agentOpen ? "Close page chat" : "Chat about this page"}
          aria-pressed={agentOpen}
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
            agentOpen && "bg-foreground/[0.07] text-foreground",
          )}
        >
          <Bot className="h-5 w-5" strokeWidth={1.85} />
        </button>
      )}
      {hasListPanel && (
        <button
          data-tauri-drag-region="false"
          type="button"
          onClick={onToggle}
          title={collapsed ? "Show sidebar (⌘\\)" : "Hide sidebar (⌘\\)"}
          aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
          aria-pressed={!collapsed}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <PanelLeft className="h-5 w-5" strokeWidth={1.85} />
        </button>
      )}
    </div>
  );
}

// Keep in sync with the layout routes that render a <ListPanel> — this
// drives the title bar's collapse toggle, the ⌘\ shortcut, and where the
// title-bar divider sits (it must line up with the panel's right border).
export function hasSurfaceListPanel(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname.startsWith("/cadence") ||
    pathname.startsWith("/mail") ||
    pathname.startsWith("/databases") ||
    pathname.startsWith("/areas") ||
    pathname.startsWith("/notebook") ||
    pathname.startsWith("/people") ||
    pathname.startsWith("/resources") ||
    pathname.startsWith("/agent")
  );
}

function VaultPathControl({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const { data: vaultPath } = useVaultPath();
  const label = formatVaultPath(vaultPath);

  return (
    <button
      data-tauri-drag-region="false"
      type="button"
      onClick={() => void navigate({ to: "/settings/vault", viewTransition: supportsViewTransition() })}
      title={vaultPath ?? "Choose vault"}
      aria-label={`Vault path: ${label}`}
      className={cn(
        "inline-flex h-8 min-w-0 shrink items-center gap-2 rounded-md border border-[hsl(0_0%_86%)] bg-[hsl(0_0%_96%)] px-3 font-mono text-[13px] leading-none text-foreground shadow-[0_1px_1px_hsl(0_0%_0%/0.035)] transition-colors hover:bg-[hsl(0_0%_94%)] dark:border-border dark:bg-content/70 dark:hover:bg-content",
        compact ? "w-[156px]" : "w-[200px]",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <ChevronDown
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        strokeWidth={1.9}
      />
    </button>
  );
}

function formatVaultPath(path: string | null | undefined): string {
  if (!path) return "~/woodshed";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed.replace(/^\/Users\/[^/]+/, "~");
}

function SortableTab(props: {
  tab: OpenTab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  canClose: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.tab.id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <Tab {...props} />
    </div>
  );
}

function Tab({
  tab,
  isActive,
  onSelect,
  onClose,
  canClose,
}: {
  tab: OpenTab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  canClose: boolean;
}) {
  // Resolve from cache so renaming a note/event/person updates the tab live;
  // the stored tab.title acts as the cold-cache fallback.
  const title = useResolvedRouteTitle(tabPath(tab), tab.title);

  return (
    <div
      data-tauri-drag-region="false"
      className={`group inline-flex h-8 min-w-[144px] max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border pl-2.5 pr-1 text-[12.5px] transition-colors ${
        isActive
          ? "border-[hsl(0_0%_86%)] bg-[hsl(0_0%_96%)] text-foreground shadow-[0_1px_1px_hsl(0_0%_0%/0.035)] dark:border-border dark:bg-content/70"
          : "border-transparent text-muted-foreground hover:bg-[hsl(0_0%_96%)] hover:text-foreground dark:hover:bg-content/45"
      }`}
      onClick={() => {
        if (!isActive) onSelect();
      }}
      role="tab"
      aria-selected={isActive}
    >
      <span className="min-w-0 truncate font-medium">{title}</span>
      <button
        data-tauri-drag-region="false"
        type="button"
        // Stop pointerdown so dnd-kit's listeners (attached to the wrapping
        // SortableTab) don't start a drag from the close button.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={`Close ${title}`}
        disabled={!canClose}
        className={`ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors ${
          canClose
            ? isActive
              ? "opacity-100 hover:bg-foreground/[0.08] hover:text-foreground"
              : "opacity-0 group-hover:opacity-100 hover:bg-foreground/[0.08] hover:text-foreground"
            : "opacity-0"
        }`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
