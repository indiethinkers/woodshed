import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { TaskEditor } from "@/components/cadence/task-editor";

export const Route = createFileRoute("/_cadence/cadence/$date/task/$id")({
  component: TaskView,
});

function TaskView() {
  const { date, id } = Route.useParams();
  return (
    <ContentPanel filePath={`tasks/${id}.md`}>
      <TaskEditor id={id} date={date} />
    </ContentPanel>
  );
}
