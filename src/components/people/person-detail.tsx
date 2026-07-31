import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Camera,
  Copy,
  MoreHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { Avatar } from "@/components/shared/avatar";
import { FavoriteToggle } from "@/components/shared/favorite-toggle";
import { FilePathLine } from "@/components/shared/file-path-pill";
import { TiptapEditor } from "@/components/shared/tiptap-editor";
import {
  EmptyValue,
  PickerPropertyValue,
  PropertyList,
  PropertyRow,
  TextPropertyValue,
} from "@/components/shared/property-list";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAreas } from "@/lib/hooks/use-areas";
import {
  usePerson,
  usePeopleMutations,
  type PersonDto,
} from "@/lib/hooks/use-people";

// Person detail page — Notion-style property list, Woodshed-quiet.
//
// Header is an avatar + large title pair. The body of the page is a single
// vertical column where property labels (JetBrains Mono, muted) sit in a
// fixed left rail and values (Söhne, foreground) fill the rest. No boxes,
// no borders, no decorative dividers. The Tiptap notes flow directly below
// the property list so the page reads as one document, not two stitched
// sections.

interface PersonDetailProps {
  id: string;
}

export function PersonDetail({ id }: PersonDetailProps) {
  const { data: person, isLoading } = usePerson(id);

  if (isLoading) {
    return <PersonSkeleton />;
  }
  if (!person) {
    return (
      <article className="w-full">
        <p className="text-sm text-muted-foreground">Person not found.</p>
      </article>
    );
  }
  return <PersonDetailInner person={person} />;
}

function PersonSkeleton() {
  return (
    <article className="w-full animate-pulse">
      <div className="flex items-center gap-4 mb-10">
        <div className="h-12 w-12 rounded-full bg-muted" />
        <div className="h-7 w-1/3 bg-muted rounded" />
      </div>
      <div className="space-y-3 max-w-prose">
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-2/3 bg-muted rounded" />
        <div className="h-4 w-3/4 bg-muted rounded" />
      </div>
    </article>
  );
}

function PersonDetailInner({ person }: { person: PersonDto }) {
  const navigate = useNavigate();
  const { update, remove, setAvatar, clearAvatar } = usePeopleMutations();
  const { data: areas = [] } = useAreas();

  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(person.name);

  // Re-sync the title draft on external edits unless the user is mid-edit.
  useEffect(() => {
    if (!nameEditing) setNameDraft(person.name);
  }, [person.name, nameEditing]);

  function commitName() {
    const next = nameDraft.trim();
    setNameEditing(false);
    if (!next || next === person.name) {
      setNameDraft(person.name);
      return;
    }
    update.mutate({ id: person.id, update: { name: next } });
  }

  // `mutateAsync` (not `mutate`) so TiptapEditor's wikilink click handler
  // — which reaches this via `onCommit={(next) => commitField("body", next)}`
  // — can await the save before navigating. Otherwise unsaved body edits
  // get stranded by an immediate route change. See use-daily-journal.ts.
  async function commitField<K extends keyof PersonDto>(field: K, next: PersonDto[K]) {
    if (next === person[field]) return;
    await update.mutateAsync({
      id: person.id,
      update: { [field]: next } as Partial<PersonDto>,
    });
  }

  // Area is the only field that can be explicitly cleared (set to null). The
  // generic `commitField` types `next` as `PersonDto[K]` which doesn't
  // include `null`, so route area through its own handler.
  async function commitArea(next: string | null) {
    if ((next ?? null) === (person.area ?? null)) return;
    await update.mutateAsync({ id: person.id, update: { area: next } });
  }

  function handleDelete() {
    remove.mutate(
      { id: person.id, retainDetail: true },
      { onSuccess: () => void navigate({ replace: true, to: "/people" }) },
    );
  }

  function handleAvatarUpload(file: File) {
    setAvatar.mutate({ id: person.id, file });
  }

  function handleAvatarClear() {
    clearAvatar.mutate({ id: person.id });
  }

  return (
    <div className="w-full max-w-[768px]">
      <PersonHeader
        person={person}
        nameEditing={nameEditing}
        nameDraft={nameDraft}
        setNameEditing={setNameEditing}
        setNameDraft={setNameDraft}
        onCommitName={commitName}
        onDelete={handleDelete}
        onToggleFavorite={() =>
          update.mutate({
            id: person.id,
            update: { favorite: !person.favorite },
          })
        }
        onAvatarUpload={handleAvatarUpload}
        onAvatarClear={handleAvatarClear}
        avatarBusy={setAvatar.isPending || clearAvatar.isPending}
      />

      <PropertyList>
        <PropertyRow label="Role" empty={!person.role}>
          <TextPropertyValue
            value={person.role}
            placeholder="Empty"
            onCommit={(v) => commitField("role", v)}
          />
        </PropertyRow>
        <PropertyRow label="Company" empty={!person.company}>
          <TextPropertyValue
            value={person.company}
            placeholder="Empty"
            onCommit={(v) => commitField("company", v)}
          />
        </PropertyRow>
        <PropertyRow label="Relationship" empty={!person.relationship}>
          <TextPropertyValue
            value={person.relationship}
            placeholder="Empty"
            onCommit={(v) => commitField("relationship", v)}
          />
        </PropertyRow>
        <PropertyRow
          label="Email"
          empty={!person.email}
          trailing={person.email ? <CopyEmailButton email={person.email} /> : undefined}
        >
          <TextPropertyValue
            value={person.email}
            placeholder="Empty"
            inputType="email"
            onCommit={(v) => commitField("email", v)}
          />
        </PropertyRow>
        <PropertyRow label="Area" empty={!person.area}>
          <PickerPropertyValue
            value={person.area ?? null}
            options={areas.map((a) => ({ value: a.id, label: a.name }))}
            clearable
            onCommit={commitArea}
          />
        </PropertyRow>
      </PropertyList>

      <div className="mt-8">
        <TiptapEditor
          value={person.body}
          onCommit={(next) => commitField("body", next)}
          placeholder="Add notes…"
          className="text-[15px] leading-normal text-foreground min-h-[60px]"
        />
      </div>
    </div>
  );
}

interface PersonHeaderProps {
  person: PersonDto;
  nameEditing: boolean;
  nameDraft: string;
  setNameEditing: (b: boolean) => void;
  setNameDraft: (s: string) => void;
  onCommitName: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
  onAvatarUpload: (file: File) => void;
  onAvatarClear: () => void;
  avatarBusy: boolean;
}

function PersonHeader({
  person,
  nameEditing,
  nameDraft,
  setNameEditing,
  setNameDraft,
  onCommitName,
  onDelete,
  onToggleFavorite,
  onAvatarUpload,
  onAvatarClear,
  avatarBusy,
}: PersonHeaderProps) {
  return (
    <header className="flex items-start gap-4 mb-10 group/header">
      <AvatarUploader
        person={person}
        onUpload={onAvatarUpload}
        onClear={onAvatarClear}
        busy={avatarBusy}
      />
      <div className="min-w-0 flex-1">
        {nameEditing ? (
          <NameInput value={nameDraft} onChange={setNameDraft} onCommit={onCommitName} />
        ) : (
          <h1
            className="text-[28px] font-semibold leading-tight tracking-[-0.02em] cursor-text -mx-1 px-1 rounded-sm hover:bg-foreground/[0.03] transition-colors truncate"
            onClick={() => setNameEditing(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setNameEditing(true);
              }
            }}
          >
            {person.name}
          </h1>
        )}
        <FilePathLine className="mt-1.5" />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <FavoriteToggle
          favorite={person.favorite}
          subject={person.name}
          onToggle={onToggleFavorite}
        />
        <MoreMenu onDelete={onDelete} personName={person.name} />
      </div>
    </header>
  );
}

/**
 * 48px avatar with a click-to-upload affordance.
 *
 * Resting: just the `<Avatar>` from `shared/avatar.tsx` — initials or
 * image, no chrome. On hover, a thin Camera glyph fades in centered
 * over the avatar so the click target's purpose is discoverable
 * without nailing decoration onto the resting state.
 *
 * Clicking the avatar opens a native file picker
 * (`input[type=file]`). Picking an image hands the File to the
 * mutation, which ships bytes to `person_avatar_set`. The same
 * affordance also exposes a small `×` overlay when there's an image
 * to clear — `person_avatar_clear` removes the field and moves the
 * underlying file to recoverable trash. Both buttons share the avatar's circular footprint
 * so the resting layout stays untouched.
 */
function AvatarUploader({
  person,
  onUpload,
  onClear,
  busy,
}: {
  person: PersonDto;
  onUpload: (file: File) => void;
  onClear: () => void;
  busy: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  function handlePick() {
    fileRef.current?.click();
  }
  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice in a row still
    // fires `change` — important after a clear-then-restore flow.
    if (e.target) e.target.value = "";
    if (file) onUpload(file);
  }
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={handlePick}
        disabled={busy}
        aria-label={person.avatar ? "Replace avatar image" : "Upload avatar image"}
        className="block rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 disabled:opacity-60"
      >
        <Avatar
          initials={person.initials}
          size="xl"
          image={person.avatar}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full bg-foreground/40 text-background flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
        >
          <Camera className="h-4 w-4" />
        </span>
      </button>
      {person.avatar && !busy && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Remove avatar image"
          title="Remove avatar"
          className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-background ring-1 ring-border text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] inline-flex items-center justify-center opacity-0 group-hover/header:opacity-100 focus:opacity-100 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
        >
          <X className="h-3 w-3" />
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={handleChange}
        className="hidden"
      />
    </div>
  );
}

function NameInput({
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
      // h-[1.25em] pins the input to the h1's exact line box (leading-tight
      // = 1.25) — WebKit ignores line-height on single-line inputs and would
      // otherwise size it from the font's natural metrics, shifting the
      // content below.
      className="w-full h-[1.25em] text-[28px] font-semibold leading-tight tracking-[-0.02em] bg-transparent outline-none focus:outline-none -mx-1 px-1 rounded-sm focus:bg-foreground/[0.03]"
    />
  );
}

function CopyEmailButton({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${email}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(email);
          setCopied(true);
          // Quiet confirmation: revert after 1.2s so the trailing slot
          // doesn't lock the row into a "feedback" state.
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard rejected — silent failure, rare in Tauri */
        }
      }}
      className="h-6 w-6 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
    >
      <Copy className="h-3.5 w-3.5" />
      <span className="sr-only">{copied ? "Copied" : "Copy email"}</span>
    </button>
  );
}

function MoreMenu({ onDelete, personName }: { onDelete: () => void; personName: string }) {
  const [confirming, setConfirming] = useState(false);
  // Reset the confirm step whenever the menu closes — otherwise re-opening
  // it would dump the user back into the "Yes, delete" state with no obvious
  // way out.
  function handleOpenChange(open: boolean) {
    if (!open) setConfirming(false);
  }
  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <EllipsisTrigger label={`More actions for ${personName}`} />
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
            Delete person…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Split out so DropdownMenuTrigger's `asChild` can wire its props onto the
// button cleanly (DropdownMenu from base-ui doesn't accept a forwardRef
// component directly without a render delegate).
function EllipsisTrigger({ label }: { label: string }) {
  return (
    <DropdownMenuTrigger
      aria-label={label}
      className="h-7 w-7 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 data-[popup-open]:bg-foreground/[0.05] data-[popup-open]:text-foreground shrink-0"
    >
      <MoreHorizontal className="h-4 w-4" />
    </DropdownMenuTrigger>
  );
}

// Re-export so consumers that previously imported the empty-value pill
// can keep using it via this module. Internal-only; helps the IDE's
// "find references" hop the layer.
export { EmptyValue };
