import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ExternalLink,
  MoreHorizontal,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { FavoriteToggle } from "@/components/shared/favorite-toggle";
import { ExternalAnchor } from "@/components/shared/external-link";
import { FilePathLine } from "@/components/shared/file-path-pill";
import { TagEditor } from "@/components/shared/tag-editor";
import { TiptapEditor } from "@/components/shared/tiptap-editor";
import {
  EmptyValue,
  PropertyList,
  PropertyRow,
} from "@/components/shared/property-list";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAllPeople, type PersonDto } from "@/lib/hooks/use-people";
import {
  useResource,
  useResourceMutations,
  type ResourceDto,
} from "@/lib/hooks/use-resources";

// Resource (saved web link) detail. Same property-list pattern as Person
// and Note, with two extras: a clickable Source row that jumps to the
// external URL, and a Highlights region above the notes for any captured
// quote blocks.

interface ResourceDetailProps {
  id: string;
}

export function ResourceDetail({ id }: ResourceDetailProps) {
  const { data: resource, isLoading } = useResource(id);

  if (isLoading) {
    return <ResourceSkeleton />;
  }
  if (!resource) {
    return (
      <article className="w-full">
        <p className="text-sm text-muted-foreground">Resource not found.</p>
      </article>
    );
  }
  return <ResourceDetailInner resource={resource} />;
}

function ResourceSkeleton() {
  return (
    <article className="w-full animate-pulse">
      <div className="h-8 w-3/4 bg-muted rounded mb-8" />
      <div className="space-y-2 mb-10">
        <div className="h-4 w-1/2 bg-muted rounded" />
        <div className="h-4 w-1/3 bg-muted rounded" />
        <div className="h-4 w-2/5 bg-muted rounded" />
      </div>
      <div className="space-y-3 max-w-prose">
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-2/3 bg-muted rounded" />
      </div>
    </article>
  );
}

function ResourceDetailInner({ resource }: { resource: ResourceDto }) {
  const navigate = useNavigate();
  const { update, remove } = useResourceMutations();
  const { data: people = [] } = useAllPeople();

  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(resource.title);

  useEffect(() => {
    if (!titleEditing) setTitleDraft(resource.title);
  }, [resource.title, titleEditing]);

  function commitTitle() {
    const next = titleDraft.trim();
    setTitleEditing(false);
    if (!next || next === resource.title) {
      setTitleDraft(resource.title);
      return;
    }
    update.mutate({ id: resource.id, update: { title: next } });
  }

  // `mutateAsync` (not `mutate`) so TiptapEditor's wikilink click handler
  // can await the save before navigating. Otherwise unsaved edits get
  // stranded by an immediate route change. See use-daily-journal.ts.
  async function commitBody(next: string) {
    if (next === resource.body) return;
    await update.mutateAsync({ id: resource.id, update: { body: next } });
  }

  function handleDelete() {
    remove.mutate(
      { id: resource.id, retainDetail: true },
      { onSuccess: () => void navigate({ replace: true, to: "/resources" }) },
    );
  }

  const capturedValue = resource.capturedAt ?? resource.saved;
  const capturedLabel = formatDateOnly(capturedValue);
  const capturedDate = localDateKey(capturedValue);
  const publishedLabel = resource.published
    ? formatDateOnly(resource.published)
    : null;

  return (
    <div className="w-full max-w-[768px]">
      <header className="mb-8">
        <div className="flex items-start justify-between gap-4">
          {titleEditing ? (
            <TitleInput
              value={titleDraft}
              onChange={setTitleDraft}
              onCommit={commitTitle}
            />
          ) : (
            <h1
              className="flex-1 min-w-0 text-[28px] font-semibold tracking-[-0.02em] leading-[1.2] cursor-text -mx-1 px-1 rounded-sm hover:bg-foreground/[0.03] transition-colors"
              onClick={() => setTitleEditing(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setTitleEditing(true);
                }
              }}
            >
              {resource.title}
            </h1>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <FavoriteToggle
              favorite={resource.favorite}
              subject={resource.title}
              onToggle={() =>
                update.mutate({
                  id: resource.id,
                  update: { favorite: !resource.favorite },
                })
              }
            />
            <MoreMenu
              resource={resource}
              onDelete={handleDelete}
            />
          </div>
        </div>
        <FilePathLine className="mt-1.5" />
      </header>

      <PropertyList>
        <PropertyRow label="Source">
          {resource.url ? (
            <ExternalAnchor
              href={resource.url}
              // `max-w-full min-w-0` lets the flex chain shrink the row so
              // the URL ellipsizes instead of running off the panel edge
              // with the open icon clipped.
              className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-[15px] text-foreground hover:underline underline-offset-2 -mx-1 px-1 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
            >
              <span className="truncate min-w-0">
                {resource.url}
              </span>
              <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
            </ExternalAnchor>
          ) : (
            <EmptyValue />
          )}
        </PropertyRow>
        <PropertyRow label="Captured">
          {capturedDate ? (
            <Link
              to="/cadence/$date"
              params={{ date: capturedDate }}
              className="font-mono text-[13px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2"
            >
              {capturedLabel}
            </Link>
          ) : (
            <span className="font-mono text-[13px] text-muted-foreground">
              {capturedLabel}
            </span>
          )}
        </PropertyRow>
        <PropertyRow label="People">
          <ResourcePeoplePicker
            peopleIds={resource.people}
            people={people}
            onCommit={(next) =>
              update.mutate({ id: resource.id, update: { people: next } })
            }
          />
        </PropertyRow>
        {publishedLabel && (
          <PropertyRow label="Published">
            <span className="font-mono text-[13px] text-muted-foreground">
              {publishedLabel}
            </span>
          </PropertyRow>
        )}
        <PropertyRow label="Tags">
          <TagEditor
            tags={resource.tags}
            onCommit={(next) =>
              update.mutate({ id: resource.id, update: { tags: next } })
            }
          />
        </PropertyRow>
      </PropertyList>

      <Separator className="mt-8" />

      {resource.highlights.length > 0 && (
        <section className="mt-10 max-w-prose">
          <h3 className="font-mono text-[13px] text-muted-foreground mb-3 select-none">
            Highlights
          </h3>
          <div className="space-y-3">
            {resource.highlights.map((highlight, i) => (
              <blockquote
                key={i}
                className="pl-4 border-l border-border text-[15px] leading-7 text-foreground/85 italic"
              >
                &ldquo;{highlight}&rdquo;
              </blockquote>
            ))}
          </div>
        </section>
      )}

      <div className="mt-8 max-w-prose">
        <TiptapEditor
          value={resource.body}
          onCommit={commitBody}
          placeholder="Add notes…"
          className="text-[15px] leading-normal text-foreground min-h-[60px]"
        />
      </div>
    </div>
  );
}

/**
 * Multi-value "People" picker for a resource. Each linked person renders
 * as a removable chip (linked to their record; legacy unmatched bylines
 * show muted with a remove affordance), plus an "Add" trigger that opens
 * the searchable person list. Every toggle commits the full replacement
 * list of person ids.
 */
function ResourcePeoplePicker({
  peopleIds,
  people,
  onCommit,
}: {
  peopleIds: string[];
  people: PersonDto[];
  onCommit: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const selectedIds = useMemo(() => new Set(peopleIds), [peopleIds]);

  const chips = useMemo(
    () =>
      peopleIds.map((entry) => ({
        entry,
        person: findPersonByReference(entry, people),
      })),
    [peopleIds, people],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return people;
    return people.filter((person) => {
      const haystack = [
        person.name,
        person.email,
        person.company,
        person.id.replaceAll("-", " "),
      ]
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(q);
    });
  }, [people, query]);

  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
    setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function toggle(personId: string) {
    const next = selectedIds.has(personId)
      ? peopleIds.filter((id) => id !== personId)
      : [...peopleIds, personId];
    onCommit(next);
  }

  return (
    <div ref={pickerRef} className="relative min-w-0">
      {chips.length === 0 ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="inline-flex items-center gap-1.5 -mx-1 px-1 rounded-sm text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
        >
          <EmptyValue>Empty</EmptyValue>
        </button>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {chips.map(({ entry, person }) =>
            person ? (
              <span
                key={entry}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-foreground/[0.03] py-0.5 pl-2 pr-1 text-[13px]"
              >
                <Link
                  to="/people/$id"
                  params={{ id: person.id }}
                  className="truncate text-foreground underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
                >
                  {person.name}
                </Link>
                <button
                  type="button"
                  aria-label={`Remove ${person.name}`}
                  onClick={() => toggle(person.id)}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : (
              <span
                key={entry}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-dashed border-border py-0.5 pl-2 pr-1 text-[13px] text-muted-foreground"
                title="Unmatched person — remove it or pick from the list"
              >
                <span className="truncate">{entry}</span>
                <button
                  type="button"
                  aria-label={`Remove ${entry}`}
                  onClick={() =>
                    onCommit(peopleIds.filter((id) => id !== entry))
                  }
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ),
          )}
          <button
            type="button"
            aria-label="Add people"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1 text-[13px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add
          </button>
        </div>
      )}
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-50 w-72 rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
            placeholder="Search people..."
            className="mb-1 h-7 w-full rounded-sm border border-border bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
          />
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-muted-foreground italic">
              {people.length === 0 ? "No people in the vault yet." : "No matches."}
            </p>
          ) : (
            <ul className="max-h-64 space-y-px overflow-y-auto">
              {filtered.map((person) => {
                const selected = selectedIds.has(person.id);
                return (
                  <li key={person.id}>
                    <button
                      type="button"
                      onClick={() => toggle(person.id)}
                      className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-foreground/[0.05] focus:bg-foreground/[0.05] focus:outline-none"
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{person.name}</span>
                        {person.email && (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {person.email}
                          </span>
                        )}
                      </span>
                      {selected && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function formatDateOnly(value: string): string {
  const dateKey = localDateKey(value);
  if (!dateKey) return value;
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function localDateKey(value: string): string | null {
  const datePrefix = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePrefix) return datePrefix[1];

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Resolve a stored people-list entry to a person record. Entries are
 * usually the linked person's id; legacy files may hold a freeform name
 * (possibly prefixed "by …"), which is matched against the name and the
 * id-with-dashes-spaced. Returns null when nothing matches.
 */
function findPersonByReference(
  reference: string,
  people: PersonDto[],
): PersonDto | null {
  if (!reference) return null;
  const normalizedReference = normalizeAuthorName(reference);
  if (!normalizedReference) return null;
  return (
    people.find((person) => person.id === reference) ??
    people.find(
      (person) => normalizeAuthorName(person.name) === normalizedReference,
    ) ??
    people.find(
      (person) =>
        normalizeAuthorName(person.id.replaceAll("-", " ")) ===
        normalizedReference,
    ) ??
    null
  );
}

function normalizeAuthorName(value: string): string {
  return value
    .replace(/^by\s+/i, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function TitleInput({
  value,
  onChange,
  onCommit,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          onCommit();
        }
      }}
      // h-[1.2em] pins the input to the h1's exact line box — WebKit
      // ignores line-height on single-line inputs and would otherwise size
      // it from the font's natural metrics, shifting the content below.
      className="flex-1 min-w-0 h-[1.2em] text-[28px] font-semibold tracking-[-0.02em] leading-[1.2] bg-transparent outline-none focus:outline-none -mx-1 px-1 rounded-sm focus:bg-foreground/[0.03]"
    />
  );
}

function MoreMenu({
  resource,
  onDelete,
}: {
  resource: ResourceDto;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  function handleOpenChange(open: boolean) {
    if (!open) setConfirming(false);
  }
  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        aria-label={`More actions for ${resource.title}`}
        className="h-7 w-7 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 data-[popup-open]:bg-foreground/[0.05] data-[popup-open]:text-foreground shrink-0"
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
        {confirming ? (
          <DropdownMenuItem
            onClick={onDelete}
            className="text-destructive focus:text-destructive flex items-center gap-2 text-[14px] cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Yes, delete
          </DropdownMenuItem>
        ) : (
          // closeOnClick={false}: Base UI Menu ignores e.preventDefault() in
          // user onClick and closes anyway, which would immediately flip
          // confirming back to false via onOpenChange.
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => setConfirming(true)}
            className="text-destructive focus:text-destructive flex items-center gap-2 text-[14px] cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete resource…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
