import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTagsWithCounts } from "@/lib/hooks/use-tag-table";

interface TagEditorProps {
  tags: string[];
  lockedTags?: string[];
  onCommit: (next: string[]) => void;
  className?: string;
}

export function normalizeTagToken(input: string): string | null {
  const clean = input
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean : null;
}

export function normalizeTagDraft(input: string): string[] {
  return normalizeTagList(input.split(/[\s,]+/));
}

export function normalizeTagList(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTagToken(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    next.push(tag);
  }
  return next;
}

export function TagEditor({
  tags,
  lockedTags = [],
  onCommit,
  className,
}: TagEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedLockedTags = normalizeTagList(lockedTags);
  const normalizedTags = normalizeTagList([...normalizedLockedTags, ...tags]);
  const { data: allTags = [] } = useTagsWithCounts();

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const normalizedDraft = normalizeTagToken(draft);
  const availableTags = useMemo(
    () =>
      allTags
        .map((entry) => entry.tag)
        .filter((tag) => !normalizedTags.includes(tag)),
    [allTags, normalizedTags],
  );

  const matchingTags = useMemo(() => {
    const needle = draft.trim().toLowerCase();
    if (!needle) return availableTags.slice(0, 8);
    return availableTags
      .filter((tag) => tag.includes(needle))
      .slice(0, 8);
  }, [availableTags, draft]);

  const canCreate =
    normalizedDraft !== null && !normalizedTags.includes(normalizedDraft);

  const menuItems = useMemo(() => {
    const items: Array<{ kind: "tag"; tag: string } | { kind: "create"; tag: string }> =
      matchingTags.map((tag) => ({ kind: "tag", tag }));
    if (canCreate && normalizedDraft) {
      items.push({ kind: "create", tag: normalizedDraft });
    }
    return items;
  }, [matchingTags, canCreate, normalizedDraft]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [draft, menuItems.length]);

  function commit(nextTags: string[]) {
    const normalized = normalizeTagList([...normalizedLockedTags, ...nextTags]);
    if (!sameTags(normalizedTags, normalized)) {
      onCommit(normalized);
    }
  }

  function addTag(tag: string) {
    const clean = normalizeTagToken(tag);
    if (!clean || normalizedTags.includes(clean)) return;
    setDraft("");
    setEditing(false);
    commit([...normalizedTags, clean]);
  }

  function commitDraft() {
    const additions = normalizeTagDraft(draft);
    setDraft("");
    setEditing(false);
    if (additions.length === 0) return;
    commit([...normalizedTags, ...additions]);
  }

  function removeTag(tag: string) {
    const clean = normalizeTagToken(tag);
    if (!clean) return;
    if (normalizedLockedTags.includes(clean)) return;
    commit(normalizedTags.filter((t) => t !== clean));
  }

  function handleInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (menuItems.length === 0) return;
      e.preventDefault();
      setHighlightIndex((index) => (index + 1) % menuItems.length);
      return;
    }
    if (e.key === "ArrowUp") {
      if (menuItems.length === 0) return;
      e.preventDefault();
      setHighlightIndex(
        (index) => (index - 1 + menuItems.length) % menuItems.length,
      );
      return;
    }
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const picked = menuItems[highlightIndex];
      if (picked) {
        addTag(picked.tag);
        return;
      }
      commitDraft();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDraft("");
      setEditing(false);
      return;
    }
    if (e.key === "Backspace" && draft.length === 0 && normalizedTags.length > 0) {
      e.preventDefault();
      commit(normalizedTags.slice(0, -1));
    }
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {normalizedTags.map((tag) => (
        <span
          key={tag}
          className="inline-flex h-5 items-center overflow-hidden rounded-md bg-muted text-xs font-medium text-muted-foreground"
        >
          <Link
            to="/databases/tags/$tag"
            params={{ tag }}
            className="px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
          >
            #{tag}
          </Link>
          {!normalizedLockedTags.includes(tag) && (
            <button
              type="button"
              aria-label={`Remove #${tag}`}
              onClick={() => removeTag(tag)}
              className="inline-flex h-5 w-5 items-center justify-center border-l border-background/70 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}

      {editing ? (
        <div className="relative">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={handleInputKeyDown}
            placeholder="Search or create tag"
            className="h-6 min-w-28 max-w-44 rounded-sm bg-transparent px-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-foreground/15"
          />
          {menuItems.length > 0 && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-44 max-w-56 rounded-md border border-border bg-popover p-1 shadow-md">
              {menuItems.map((item, index) => (
                <button
                  key={`${item.kind}-${item.tag}`}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => addTag(item.tag)}
                  className={cn(
                    "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[13px] transition-colors",
                    index === highlightIndex
                      ? "bg-foreground/[0.06] text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
                  )}
                >
                  {item.kind === "create" ? (
                    <>Create #{item.tag}</>
                  ) : (
                    <>#{item.tag}</>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
        >
          <Plus className="h-3.5 w-3.5" />
          Tag
        </button>
      )}
    </div>
  );
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((tag, index) => tag === b[index]);
}
