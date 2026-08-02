import { useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { FileText, Folder, Library } from "lucide-react";
import {
  ListSidebar,
  ListSidebarPrimaryAction,
  ListSidebarSectionHeader,
} from "@/components/shared/list-sidebar";
import { RecordContextSidebar } from "@/components/shared/record-context-sidebar";
import {
  useAllNotes,
  useNote,
  useNoteMutations,
  type NoteDto,
} from "@/lib/hooks/use-notes";

export function NoteContextSidebar({ id }: { id: string }) {
  const { data: note } = useNote(id);
  if (!note) return null;
  return (
    <RecordContextSidebar
      id={note.id}
      title={note.title || "(untitled)"}
      primaryAction={<NewNoteAction />}
    />
  );
}

/** Notebook index navigator: quick access to favorite notes. */
export function NotebookIndexSidebar() {
  const { data, isLoading } = useAllNotes();
  const { folder: selectedFolder } = useSearch({ from: "/notebook/" });
  const folders = useMemo(() => notebookFolders(data ?? []), [data]);
  const favorites = (data ?? []).filter((note) => note.favorite).slice(0, 5);

  return (
    <ListSidebar title="Notebook" count={data?.length ?? 0}>
      <NewNoteAction />
      <ListSidebarSectionHeader label="Folders" count={folders.length} />
      <div className="space-y-0.5">
        <FolderLink label="Woodshed" icon={Library} active={!selectedFolder} />
        {folders.map((folder) => (
          <FolderLink
            key={folder.path}
            label={folder.name}
            folder={folder.path}
            count={folder.count}
            depth={folder.depth}
            icon={Folder}
            active={selectedFolder === folder.path}
          />
        ))}
        {isLoading && (
          <p className="px-2 py-3 text-xs text-muted-foreground">Scanning folders…</p>
        )}
      </div>
      {favorites.length > 0 && (
        <div className="mt-6">
          <ListSidebarSectionHeader label="Favorites" count={favorites.length} />
          <div className="space-y-0.5">
            {favorites.map((note) => (
              <Link
                key={note.id}
                to="/notebook/$id"
                params={{ id: note.id }}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-foreground/85 hover:bg-foreground/[0.04]"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{note.title || "(untitled)"}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </ListSidebar>
  );
}

export function notebookFolders(notes: NoteDto[]) {
  const counts = new Map<string, number>();
  for (const note of notes) {
    if (!note.folder || note.folder === ".") continue;
    const segments = note.folder.split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      const path = segments.slice(0, index + 1).join("/");
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([path, count]) => {
    const segments = path.split("/");
    return {
      path,
      name: segments.at(-1) ?? path,
      depth: segments.length - 1,
      count,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function FolderLink({
  label,
  folder,
  count,
  depth = 0,
  active,
  icon: Icon,
}: {
  label: string;
  folder?: string;
  count?: number;
  depth?: number;
  active: boolean;
  icon: typeof Folder;
}) {
  return (
    <Link
      to="/notebook"
      search={folder ? { folder } : {}}
      className={`flex h-8 items-center gap-2 rounded-lg pr-2 text-[13px] transition-colors ${
        active
          ? "bg-foreground/[0.055] text-foreground"
          : "text-foreground/80 hover:bg-foreground/[0.04]"
      }`}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.7} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </Link>
  );
}

function NewNoteAction() {
  const navigate = useNavigate();
  const { create } = useNoteMutations();
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const note = await create.mutateAsync({ title: "Untitled" });
      void navigate({ to: "/notebook/$id", params: { id: note.id } });
    } finally {
      setCreating(false);
    }
  }

  return (
    <ListSidebarPrimaryAction
      label="New note"
      onClick={() => void handleCreate()}
      disabled={creating}
    />
  );
}
