import { createFileRoute } from "@tanstack/react-router";
import { ContentPanel } from "@/components/layout/content-panel";
import { PeopleList } from "@/components/people/people-list";

export const Route = createFileRoute("/people/")({
  component: PeopleIndexPage,
});

function PeopleIndexPage() {
  return (
    <ContentPanel wide filePath="people/">
      <PeopleList />
    </ContentPanel>
  );
}
