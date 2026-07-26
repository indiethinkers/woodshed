import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Avatar } from "@/components/shared/avatar";
import {
  ListSidebar,
  ListSidebarEmpty,
  ListSidebarPrimaryAction,
  ListSidebarRow,
  ListSidebarSection,
} from "@/components/shared/list-sidebar";
import { RecordContextSidebar } from "@/components/shared/record-context-sidebar";
import { useAllMail } from "@/lib/hooks/use-mail";
import { useAllNotes } from "@/lib/hooks/use-notes";
import {
  useAllPeople,
  usePerson,
  type PersonDto,
} from "@/lib/hooks/use-people";
import { useAllResources } from "@/lib/hooks/use-resources";
import { useTagTable } from "@/lib/hooks/use-tag-table";
import { useAllTasks } from "@/lib/hooks/use-tasks";
import { NewPersonForm } from "./new-person-form";
import {
  type BuildPersonActivityInput,
  buildPersonActivity,
  type PersonActivityItem,
} from "@/lib/people/activity";

type PersonActivitySources = Pick<
  BuildPersonActivityInput,
  "notes" | "tasks" | "eventRows" | "emails"
> & {
  resources: NonNullable<BuildPersonActivityInput["resources"]>;
};

// People detail sidebar: Mentioned-in graph context first, then Activity
// (everything in the vault linked to this person — mail, events, tasks,
// notes, resources), followed by outgoing Links. Lived in the content
// column until June 2026; moved here so the page body stays a clean measure.

export function PersonContextSidebar({ id }: { id: string }) {
  const { data: person } = usePerson(id);
  const activitySources = usePersonActivitySources();

  const activity = useMemo(
    () => (person ? buildPersonActivity({ person, ...activitySources }) : []),
    [activitySources, person],
  );

  if (!person) return null;

  return (
    <RecordContextSidebar
      id={person.id}
      title={person.name}
      primaryAction={<NewPersonControl />}
      backlinksTitle="Mentioned in"
      backlinksFirst
      afterBacklinks={
        activity.length > 0 ? <PersonActivity items={activity} /> : undefined
      }
    />
  );
}

/** People index list panel: starred profiles kept within easy reach. */
export function PeopleIndexSidebar() {
  const { data } = useAllPeople();
  const favorites = useMemo(
    () =>
      (data ?? [])
        .filter((person) => person.favorite)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [data],
  );

  return (
    <ListSidebar>
      <NewPersonControl />
      <ListSidebarSection label="Favorites" count={favorites.length}>
        {favorites.length > 0 ? (
          favorites.map((person) => (
            <PersonSidebarRow key={person.id} person={person} />
          ))
        ) : (
          <ListSidebarEmpty>
            Star a person to keep them within reach.
          </ListSidebarEmpty>
        )}
      </ListSidebarSection>
    </ListSidebar>
  );
}

function NewPersonControl() {
  const [adding, setAdding] = useState(false);

  if (adding) {
    return (
      <div className="mb-5">
        <NewPersonForm
          onCreated={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      </div>
    );
  }

  return (
    <ListSidebarPrimaryAction
      label="New person"
      onClick={() => setAdding(true)}
    />
  );
}

function usePersonActivitySources(): PersonActivitySources {
  const { data: notes = [] } = useAllNotes();
  const { data: tasks = [] } = useAllTasks();
  const { data: eventRows = [] } = useTagTable("event");
  const { data: emails = [] } = useAllMail();
  const { data: resources = [] } = useAllResources();

  return useMemo(
    () => ({ notes, tasks, eventRows, emails, resources }),
    [emails, eventRows, notes, resources, tasks],
  );
}

function PersonSidebarRow({
  person,
  meta,
}: {
  person: PersonDto;
  meta?: string;
}) {
  return (
    <ListSidebarRow
      href={`/people/${person.id}`}
      title={person.name}
      meta={
        meta ??
        ([person.role, person.company].filter(Boolean).join(" · ") || undefined)
      }
      leading={
        <Avatar initials={person.initials} image={person.avatar} size="sm" />
      }
    />
  );
}

function PersonActivity({ items }: { items: PersonActivityItem[] }) {
  return (
    <ListSidebarSection label="Activity" count={items.length}>
      {items.map((item) => (
        <Link
          key={item.id}
          to={item.href}
          className="flex items-start gap-2.5 rounded-lg px-2 py-[7px] transition-colors hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06]"
        >
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-[13.5px] font-medium leading-[1.35] text-foreground">
              {item.title}
            </span>
            {item.subtitle && (
              <span className="mt-[3px] block truncate text-[12px] leading-snug text-muted-foreground/80">
                {item.subtitle}
              </span>
            )}
          </span>
          {item.date && (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/75">
              {formatActivityDate(item.date)}
            </span>
          )}
        </Link>
      ))}
    </ListSidebarSection>
  );
}

function formatActivityDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
