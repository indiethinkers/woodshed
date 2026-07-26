import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { PersonDetail } from "@/components/people/person-detail";
import { usePerson } from "@/lib/hooks/use-people";

export const Route = createFileRoute("/people/$id")({
  component: PersonView,
});

function PersonView() {
  const { id } = Route.useParams();
  const { data: person } = usePerson(id);

  return (
    <ContentPanel filePath={person?.path}>
      <PersonDetail id={id} />
    </ContentPanel>
  );
}
