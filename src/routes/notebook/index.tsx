import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { NoteList } from "@/components/notebook/note-list";

export const Route = createFileRoute("/notebook/")({
  component: NotebookIndexPage,
});

function NotebookIndexPage() {
  return (
    <ContentPanel wide filePath="notebook/">
      <NoteList />
    </ContentPanel>
  );
}
