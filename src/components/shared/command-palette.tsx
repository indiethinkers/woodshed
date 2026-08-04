import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useRouterState, useNavigate } from "@tanstack/react-router";
import { Loader2, PanelRight, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import {
  compileResults,
  type CommandAction,
  type CommandGroup,
  type CommandItem,
} from "@/lib/command-search";
import { useAreaMutations, useAreas } from "@/lib/hooks/use-areas";
import { useNoteMutations } from "@/lib/hooks/use-notes";
import { usePeopleMutations } from "@/lib/hooks/use-people";
import { useResourceMutations } from "@/lib/hooks/use-resources";
import { useSearch } from "@/lib/hooks/use-search";
import { useTableMutations } from "@/lib/hooks/use-tables";
import { useTaskMutations } from "@/lib/hooks/use-tasks";
import { useToday } from "@/lib/hooks/use-today";
import { isEditableElement } from "@/lib/dom/is-editable";
import { UNASSIGNED_AREA_ID } from "@/lib/areas";
import { useTabs } from "@/components/layout/tabs-context-internal";
import { useRightSidebar } from "@/components/layout/right-sidebar-context-internal";

type PaletteMode = "navigate" | "new-tab" | "right-sidebar";
type SelectionIntent = "reference" | "new-tab";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Latch the launch mode on open: normal navigation, open-in-new-tab,
  // or add-to-references. Enter then does the right thing without per-row
  // modifier juggling.
  const [mode, setMode] = useState<PaletteMode>("navigate");
  const navigate = useNavigate();
  const { openInNewTab } = useTabs();
  const { addPage } = useRightSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: areas = [] } = useAreas();
  const { create: createArea } = useAreaMutations();
  const { create: createNote } = useNoteMutations();
  const { create: createPerson } = usePeopleMutations();
  const { create: createResource } = useResourceMutations();
  const { create: createTable } = useTableMutations();
  const { create: createTask } = useTaskMutations();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Gate mouse-hover selection until the cursor has actually moved after
  // the palette opens. Without this, opening the modal while the cursor
  // happens to be over a row fires `mouseEnter` immediately and steals the
  // keyboard-selected first row — confusing because the user didn't move
  // the mouse.
  const hoverArmed = useRef(false);

  const today = useToday();
  const search = useSearch(query);
  const taskArea = useMemo(
    () => resolveDefaultTaskArea(pathname, areas),
    [pathname, areas],
  );
  const groups = useMemo<CommandGroup[]>(
    () => compileResults({ query, today, hits: search.data ?? [] }),
    [query, today, search.data],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setMode("navigate");
  }, []);

  // Active-row policy:
  //   - When the query *string* changes (user types or deletes), snap to
  //     the top result. The leader at the top is the most relevant answer
  //     for the new query, and clinging to a prior selection means typing
  //     "tod" can leave "Cadence" highlighted while "Today" sits on top.
  //   - When `flat` changes for any other reason (async FTS5 hits arriving
  //     after the sync nav-page pass, placeholder → fresh swap), preserve
  //     the current activeId if it's still in the result set. This is what
  //     keeps the highlight from yo-yoing as hits land mid-keystroke.
  const prevQueryRef = useRef(query);
  useEffect(() => {
    const queryChanged = prevQueryRef.current !== query;
    prevQueryRef.current = query;
    setActiveId((current) => {
      if (queryChanged) return flat[0]?.id ?? null;
      if (current && flat.some((i) => i.id === current)) return current;
      return flat[0]?.id ?? null;
    });
  }, [flat, query]);

  // Three keyboard entry points to the palette:
  //   1. ⌘K / Ctrl-K — universal toggle.
  //   2. Type-to-search — when no editable element is focused and the user
  //      taps a letter or digit, open the palette and seed it with that
  //      character. Only letters and digits trigger — punctuation, arrows,
  //      Tab, Enter, Escape, and IME composition are ignored.
  //   3. The custom `woodshed:open-palette` event for trigger buttons
  //      outside the React tree (e.g. the title-bar search bar). It can
  //      carry an optional `detail.seed` string to pre-fill the input.
  //
  // Escape is handled globally (not just on the input) — when the palette
  // is opened by mouse click, focus may not reach the input before the
  // user reaches for the keyboard, and an input-only Esc handler would
  // silently fail.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((wasOpen) => !wasOpen);
        setMode("navigate");
        return;
      }
      // ⌘T mirrors ⌘K but flips the palette into "open in new tab"
      // mode — Enter (or click) on a result appends a tab rather than
      // replacing the active one. Matches Chrome's ⌘T muscle memory:
      // user expects a fresh tab, with the entry surface picking the
      // destination.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setMode("new-tab");
        setOpen(true);
        return;
      }
      if (e.key === "Escape") {
        setOpen((wasOpen) => {
          if (wasOpen) e.preventDefault();
          return false;
        });
        setQuery("");
        setMode("navigate");
        return;
      }

      // Type-to-search. All gates must pass.
      if (open) return;
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key.length !== 1 || !/^[a-zA-Z0-9]$/.test(e.key)) return;
      // Mail detail owns printable keys for its single-key actions (R reply,
      // E archive, F forward, J/K navigation). Keep explicit palette entry
      // points such as Command-K available, but don't let global typeahead
      // steal those shortcuts.
      if (/^\/mail\/[^/]+\/?$/.test(pathname)) return;
      if (document.querySelector('[data-mail-index-focused="true"]')) return;
      if (
        isEditableElement(e.target) ||
        isEditableElement(document.activeElement)
      ) {
        return;
      }
      if (
        document.querySelector(
          "[data-slot='dialog-content'], [data-slot='alert-dialog-content']",
        )
      ) {
        return;
      }
      e.preventDefault();
      setQuery(e.key);
      setOpen(true);
    }
    function onOpen(e: Event) {
      const seed =
        e instanceof CustomEvent &&
        e.detail &&
        typeof e.detail.seed === "string"
          ? e.detail.seed
          : null;
      const nextMode =
        e instanceof CustomEvent &&
        e.detail &&
        e.detail.mode === "right-sidebar"
          ? "right-sidebar"
          : "navigate";
      if (seed !== null) setQuery(seed);
      setMode(nextMode);
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("woodshed:open-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("woodshed:open-palette", onOpen);
    };
  }, [open, pathname]);

  // Focus the input on open.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Arm hover only after the cursor moves. Closing re-disarms so the next
  // open starts in the safe state.
  useEffect(() => {
    if (!open) {
      hoverArmed.current = false;
      return;
    }
    function arm() {
      hoverArmed.current = true;
    }
    window.addEventListener("pointermove", arm, { once: true });
    return () => window.removeEventListener("pointermove", arm);
  }, [open]);

  const handleHover = useCallback((id: string) => {
    if (!hoverArmed.current) return;
    setActiveId(id);
  }, []);

  function openItem(item: CommandItem, intent?: SelectionIntent) {
    if (item.action) {
      void runActionItem(item, intent);
      return;
    }
    // item.href is a runtime-built string (navPages hardcodes plain paths
    // like "/people"; date-keyword items produce "/cadence/<date>"; backend
    // FTS5 hits produce "/notebook/<id>", "/people/<id>",
    // "/resources/<id>", and so on). Use TanStack Router's `href`
    // option rather than `to` —
    // `to` is typed against the route registry and would reject these as
    // bare strings, whereas `href` parses the pathname + search and
    // navigates to whichever route matches.
    //
    // `viewTransition: true` lets the router drive the crossfade. We
    // intentionally don't wrap this in document.startViewTransition
    // ourselves — that path awaited navigate()'s Promise and stuck on
    // any slow loader, freezing further clicks.
    const targetNewTab = mode === "new-tab" || intent === "new-tab";
    const targetReference =
      mode === "right-sidebar" || intent === "reference";
    if (targetReference && !targetNewTab) {
      close();
      addPage({ href: item.href, title: item.label });
      return;
    }
    close();
    if (targetNewTab) {
      // openInNewTab handles both the strip mutation (append + activate)
      // and the navigate() call, so the new tab lands on the right path
      // without a flash through "/".
      openInNewTab(item.href);
      return;
    }
    void navigate({ href: item.href, viewTransition: true });
  }

  async function runActionItem(item: CommandItem, intent?: SelectionIntent) {
    if (!item.action || pendingId) return;
    const targetNewTab = mode === "new-tab" || intent === "new-tab";
    const targetReference =
      mode === "right-sidebar" || intent === "reference";
    setPendingId(item.id);
    try {
      const href = await executeAction(item.action);
      close();
      toast.success(actionToastLabel(item.action), {
        description: actionToastDescription(item.action),
      });
      if (targetReference) {
        addPage({ href, title: createdReferenceTitle(item.action) });
        return;
      }
      if (targetNewTab) {
        openInNewTab(href);
        return;
      }
      void navigate({ href, viewTransition: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Command failed", { description: message });
    } finally {
      setPendingId(null);
    }
  }

  async function executeAction(action: CommandAction): Promise<string> {
    switch (action.type) {
      case "create-note": {
        const note = await createNote.mutateAsync({
          title: action.title,
          body: "",
        });
        return `/notebook/${encodeURIComponent(note.id)}`;
      }
      case "create-task": {
        if (!taskArea) {
          throw new Error("Create an area before quick-creating tasks.");
        }
        const task = await createTask.mutateAsync({
          content: action.content,
          area: taskArea,
          scheduled: today,
        });
        return `/cadence/${task.scheduled ?? today}/task/${encodeURIComponent(task.id)}`;
      }
      case "create-person": {
        const person = await createPerson.mutateAsync({
          name: action.name,
          role: "",
          company: "",
          email: "",
          body: "",
        });
        return `/people/${encodeURIComponent(person.id)}`;
      }
      case "create-resource": {
        const resource = await createResource.mutateAsync({
          title: action.title,
          url: action.url,
          source: action.source,
        });
        return `/resources/${encodeURIComponent(resource.id)}`;
      }
      case "create-area": {
        const area = await createArea.mutateAsync({ name: action.name });
        return `/areas/${encodeURIComponent(area.id)}`;
      }
      case "create-table": {
        const table = await createTable.mutateAsync({ name: action.name });
        return `/databases/${encodeURIComponent(table.id)}`;
      }
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = flat.find((i) => i.id === activeId) ?? flat[0];
      if (item) openItem(item);
    }
  }

  function moveActive(delta: number) {
    if (!flat.length) return;
    const idx = flat.findIndex((i) => i.id === activeId);
    const next = idx === -1 ? 0 : (idx + delta + flat.length) % flat.length;
    const nextItem = flat[next];
    setActiveId(nextItem.id);
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-command-id="${CSS.escape(nextItem.id)}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[96px] px-4">
      {/* Backdrop is its own element with the close handler — putting the
          handler on the outer container failed because the backdrop is
          stacked between the container and the modal, so e.target was
          always the backdrop and the e.target === e.currentTarget guard
          never matched. */}
      <button
        type="button"
        aria-label="Close command palette"
        onClick={close}
        className="absolute inset-0 bg-black/30 backdrop-blur-[2px] cursor-default animate-in fade-in-0 duration-150"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        // Fixed frame: the modal never resizes with results. Content scrolls
        // or shows an empty-state inside this frame. Earlier versions tied
        // height to content (`min-h` + `max-h-60vh`), which made the bottom
        // edge yo-yo on every keystroke — the loudest source of jank.
        className="relative w-full max-w-[600px] h-[min(440px,70vh)] bg-popover text-popover-foreground border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in-0 slide-in-from-top-2 duration-150"
      >
        <div className="flex items-center gap-2 px-3 h-11 border-b border-border">
          {mode === "new-tab" ? (
            <Plus
              className="h-4 w-4 text-muted-foreground shrink-0"
              strokeWidth={1.75}
              aria-label="Open in new tab"
            />
          ) : mode === "right-sidebar" ? (
            <PanelRight
              className="h-4 w-4 text-muted-foreground shrink-0"
              strokeWidth={1.75}
              aria-label="Open in references"
            />
          ) : (
            <Search className="h-4 w-4 text-muted-foreground shrink-0" strokeWidth={1.75} />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={
              mode === "new-tab"
                ? "Open in new tab…"
                : mode === "right-sidebar"
                  ? "Open in references…"
                : "Search pages, people, notes…"
            }
            className="flex-1 h-full bg-transparent outline-none text-[14px] placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
          {search.isFetching && (
            <Loader2
              className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0 animate-spin"
              strokeWidth={2}
              aria-hidden
            />
          )}
          <kbd className="hidden sm:inline-flex items-center px-1.5 h-5 rounded text-[10.5px] font-medium text-muted-foreground bg-foreground/[0.06] border border-border">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {flat.length === 0 ? (
            // Empty / loading state is pinned to the top of the list area so
            // the eye never has to track a centered element popping in and
            // out as results arrive. During an in-flight fetch we render
            // nothing — the fixed modal frame holds the space, and the
            // input's inline indicator (right side of the search row)
            // signals progress without a layout shift.
            search.isFetching ? null : (
              <div className="px-4 pt-8">
                <p className="text-sm text-muted-foreground">
                  No results for “{query}”
                </p>
              </div>
            )
          ) : (
            groups.map((g) => (
              <Group
                key={g.kind}
                group={g}
                activeId={activeId}
                pendingId={pendingId}
                onHover={handleHover}
                onSelect={openItem}
              />
            ))
          )}
        </div>

        <div className="hidden sm:flex items-center justify-end gap-3 px-3 h-7 text-[11px] text-muted-foreground border-t border-border bg-foreground/[0.02]">
          <Hint keys={["↑", "↓"]} label="Navigate" />
          <Hint
            keys={["↵"]}
            label={
              mode === "new-tab"
                ? "Open in new tab"
                : mode === "right-sidebar"
                  ? "Add reference"
                  : "Open"
            }
          />
          <Hint keys={["esc"]} label="Close" />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Group({
  group,
  activeId,
  pendingId,
  onHover,
  onSelect,
}: {
  group: CommandGroup;
  activeId: string | null;
  pendingId: string | null;
  onHover: (id: string) => void;
  onSelect: (item: CommandItem, intent?: SelectionIntent) => void;
}) {
  return (
    <div className="py-1">
      <div className="px-3 py-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
        {group.label}
      </div>
      {group.items.map((item) => (
        <Row
          key={item.id}
          item={item}
          active={item.id === activeId}
          pending={item.id === pendingId}
          onHover={() => onHover(item.id)}
          onSelect={(intent) => onSelect(item, intent)}
        />
      ))}
    </div>
  );
}

function Row({
  item,
  active,
  pending,
  onHover,
  onSelect,
}: {
  item: CommandItem;
  active: boolean;
  pending: boolean;
  onHover: () => void;
  onSelect: (intent?: SelectionIntent) => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-command-id={item.id}
      onMouseEnter={onHover}
      onClick={(e) => {
        const shifted = e.shiftKey;
        const meta = e.metaKey || e.ctrlKey;
        onSelect(shifted ? (meta ? "new-tab" : "reference") : undefined);
      }}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
        active ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.04]"
      }`}
    >
      {pending ? (
        <Loader2
          className="h-4 w-4 text-muted-foreground shrink-0 animate-spin"
          strokeWidth={1.75}
        />
      ) : (
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" strokeWidth={1.75} />
      )}
      <span className="text-[13.5px] text-foreground truncate">{item.label}</span>
      {item.hint && (
        <span className="ml-auto text-[12px] text-muted-foreground truncate max-w-[40%]">
          {item.hint}
        </span>
      )}
    </button>
  );
}

function resolveDefaultTaskArea(
  pathname: string | undefined,
  areas: { id: string }[],
): string | null {
  const routeArea = routeAreaFromPathname(pathname);
  if (routeArea && routeArea !== UNASSIGNED_AREA_ID) {
    return routeArea;
  }
  return areas.find((area) => area.id !== UNASSIGNED_AREA_ID)?.id ?? null;
}

function routeAreaFromPathname(pathname: string | undefined): string | null {
  const match = pathname?.match(/^\/areas\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function actionToastLabel(action: CommandAction): string {
  switch (action.type) {
    case "create-note":
      return "Note created";
    case "create-task":
      return "Task created";
    case "create-person":
      return "Person created";
    case "create-resource":
      return "Resource saved";
    case "create-area":
      return "Area created";
    case "create-table":
      return "Table created";
  }
}

function actionToastDescription(action: CommandAction): string {
  switch (action.type) {
    case "create-note":
      return action.title;
    case "create-task":
      return action.content;
    case "create-person":
      return action.name;
    case "create-resource":
      return action.url;
    case "create-area":
      return action.name;
    case "create-table":
      return action.name;
  }
}

function createdReferenceTitle(action: CommandAction): string {
  switch (action.type) {
    case "create-note":
      return action.title;
    case "create-task":
      return action.content;
    case "create-person":
      return action.name;
    case "create-resource":
      return action.title;
    case "create-area":
      return action.name;
    case "create-table":
      return action.name;
  }
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded text-[10px] font-medium bg-foreground/[0.06] border border-border"
        >
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  );
}
