import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { NoteList } from "@/components/notebook/note-list";

export const Route = createFileRoute("/notebook/")({
  validateSearch: (search: Record<string, unknown>): { folder?: string } =>
    typeof search.folder === "string" ? { folder: search.folder } : {},
  component: NotebookIndexPage,
});

function NotebookIndexPage() {
  return (
    <ContentPanel wide filePath="notebook/">
      <NoteList />
    </ContentPanel>
  );
}
