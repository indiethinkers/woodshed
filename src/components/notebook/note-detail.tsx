import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { FavoriteToggle } from "@/components/shared/favorite-toggle";
import { FilePathLine } from "@/components/shared/file-path-pill";
import { TagEditor } from "@/components/shared/tag-editor";
import { TiptapEditor } from "@/components/shared/tiptap-editor";
import {
  PickerPropertyValue,
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
import { useAreas } from "@/lib/hooks/use-areas";
import {
  useNote,
  useNoteMutations,
  type NoteDto,
} from "@/lib/hooks/use-notes";

// Long-form note detail. Same property-list shape the rest of the
// detail-page family uses, with one calibration for this surface: the
// title can be quite long (essay headlines, working drafts) so we let it
// wrap to two lines instead of truncating, and the Tiptap editor takes
// `max-w-prose` to keep paragraphs at a comfortable reading measure.

interface NoteDetailProps {
  id: string;
}

export function NoteDetail({ id }: NoteDetailProps) {
  const { data: note, isLoading } = useNote(id);

  if (isLoading) {
    return <NoteSkeleton />;
  }
  if (!note) {
    return (
      <article className="w-full">
        <p className="text-sm text-muted-foreground">Note not found.</p>
      </article>
    );
  }
  return <NoteDetailInner key={note.id} note={note} />;
}

function NoteSkeleton() {
  return (
    <article className="w-full animate-pulse">
      <div className="h-9 w-2/3 bg-muted rounded mb-8" />
      <div className="space-y-2 mb-10">
        <div className="h-4 w-1/2 bg-muted rounded" />
        <div className="h-4 w-1/3 bg-muted rounded" />
      </div>
      <div className="space-y-3 max-w-prose">
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-2/3 bg-muted rounded" />
      </div>
    </article>
  );
}

function NoteDetailInner({ note }: { note: NoteDto }) {
  const navigate = useNavigate();
  const { update, remove } = useNoteMutations();
  const { data: areas = [] } = useAreas();

  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(note.title);

  useEffect(() => {
    if (!titleEditing) setTitleDraft(note.title);
  }, [note.title, titleEditing]);

  async function commitTitle() {
    const next = titleDraft.trim();
    setTitleEditing(false);
    if (!next || next === note.title) {
      setTitleDraft(note.title);
      return;
    }
    const updated = await update.mutateAsync({
      id: note.id,
      update: { title: next },
    });
    // Backend may rename the file to keep the id/title slug aligned.
    // Follow the URL so the route doesn't 404.
    if (updated.id !== note.id) {
      void navigate({
        replace: true,
        to: "/notebook/$id",
        params: { id: updated.id },
      });
    }
  }

  // `mutateAsync` (not `mutate`) so TiptapEditor's wikilink click handler
  // can await the save before navigating. Otherwise unsaved edits get
  // stranded by an immediate route change. See use-daily-journal.ts.
  async function commitBody(next: string) {
    if (next === note.body) return;
    await update.mutateAsync({ id: note.id, update: { body: next } });
  }

  function commitArea(next: string | null) {
    if ((next ?? null) === (note.area ?? null)) return;
    update.mutate({ id: note.id, update: { area: next } });
  }

  function commitTags(next: string[]) {
    update.mutate({ id: note.id, update: { tags: next } });
  }

  function handleDelete() {
    remove.mutate(
      { id: note.id, retainDetail: true },
      { onSuccess: () => void navigate({ replace: true, to: "/notebook" }) },
    );
  }

  const createdLabel = new Date(note.created).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

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
              className="flex-1 min-w-0 text-[32px] font-semibold tracking-[-0.025em] leading-[1.15] cursor-text -mx-1 px-1 rounded-sm hover:bg-foreground/[0.03] transition-colors"
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
              {note.title}
            </h1>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <FavoriteToggle
              favorite={note.favorite}
              subject={note.title}
              onToggle={() =>
                update.mutate({
                  id: note.id,
                  update: { favorite: !note.favorite },
                })
              }
            />
            <MoreMenu onDelete={handleDelete} noteTitle={note.title} />
          </div>
        </div>
        <FilePathLine className="mt-1.5" />
      </header>

      <PropertyList>
        <PropertyRow label="Area">
          <PickerPropertyValue
            value={note.area ?? null}
            options={areas.map((a) => ({ value: a.id, label: a.name }))}
            clearable
            onCommit={commitArea}
          />
        </PropertyRow>
        <PropertyRow label="Created">
          <span className="font-mono text-[13px] text-muted-foreground">
            {createdLabel}
          </span>
        </PropertyRow>
        <PropertyRow label="Tags">
          <TagEditor tags={note.tags} onCommit={commitTags} />
        </PropertyRow>
      </PropertyList>

      <Separator className="mt-8" />

      <div className="mt-8 max-w-prose">
        <TiptapEditor
          value={note.body}
          onCommit={commitBody}
          unwrapOutlineOnLoad
          placeholder="Start writing..."
          className="text-base leading-normal min-h-[120px]"
        />
      </div>
    </div>
  );
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
      // h-[1.15em] pins the input to the h1's exact line box — WebKit
      // ignores line-height on single-line inputs and would otherwise size
      // it from the font's natural metrics, shifting the content below.
      className="flex-1 min-w-0 h-[1.15em] text-[32px] font-semibold tracking-[-0.025em] leading-[1.15] bg-transparent outline-none focus:outline-none -mx-1 px-1 rounded-sm focus:bg-foreground/[0.03]"
    />
  );
}

function MoreMenu({ onDelete, noteTitle }: { onDelete: () => void; noteTitle: string }) {
  const [confirming, setConfirming] = useState(false);
  function handleOpenChange(open: boolean) {
    if (!open) setConfirming(false);
  }
  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        aria-label={`More actions for ${noteTitle}`}
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
          // confirming back to false via onOpenChange. We need the menu to
          // stay open between "Delete…" and the "Yes, delete" confirm step.
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => setConfirming(true)}
            className="text-destructive focus:text-destructive flex items-center gap-2 text-[14px] cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete note…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
