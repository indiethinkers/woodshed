import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { NoteDetail } from "@/components/notebook/note-detail";
import { useNote } from "@/lib/hooks/use-notes";

export const Route = createFileRoute("/notebook/$id")({
  component: NoteView,
});

function NoteView() {
  const { id } = Route.useParams();
  const { data: note } = useNote(id);

  return (
    <ContentPanel filePath={note?.path}>
      <NoteDetail id={id} />
    </ContentPanel>
  );
}
