import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChronologicalSidebar } from "@/components/shared/chronological-sidebar";
import { ListSidebarPrimaryAction } from "@/components/shared/list-sidebar";
import { RecordContextSidebar } from "@/components/shared/record-context-sidebar";
import { useToday } from "@/lib/hooks/use-today";
import { getMarkdownPreview } from "@/lib/markdown-preview";
import { useAllNotes, useNote, useNoteMutations } from "@/lib/hooks/use-notes";

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

/** Notebook index navigator: favorites pinned above chronological buckets. */
export function NotebookIndexSidebar() {
  const today = useToday();
  const { data, isLoading } = useAllNotes();

  const items = useMemo(
    () =>
      (data ?? []).map((note) => ({
        id: note.id,
        href: `/notebook/${note.id}`,
        title: note.title || "(untitled)",
        date: note.created,
        preview: getMarkdownPreview(note.body),
        favorite: note.favorite,
      })),
    [data],
  );

  return (
    <ChronologicalSidebar
      items={items}
      referenceDate={new Date(`${today}T00:00:00`)}
      isLoading={isLoading}
      emptyMessage="No notes yet. Create one above."
      favoriteEmptyMessage="Star a note to keep it within reach."
      action={<NewNoteAction />}
    />
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
