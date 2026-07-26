import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Briefcase,
  Building2,
  CalendarClock,
  CalendarDays,
  FolderKanban,
  Mail,
  Plus,
  User,
} from "lucide-react";
import {
  RecordTable,
  selectOptionsFromValues,
  useRecordTableState,
  type RecordColumn,
} from "@/components/tables/record-table";
import {
  useAllPeople,
  usePeopleMutations,
  type PersonDto,
} from "@/lib/hooks/use-people";
import type { ViewSort } from "@/lib/hooks/use-tables";
import { NewPersonForm } from "./new-person-form";

const DEFAULT_SORTS: ViewSort[] = [{ column: "created", direction: "desc" }];

const COLUMNS: RecordColumn<PersonDto>[] = [
  {
    id: "name",
    name: "Name",
    type: "text",
    icon: User,
    width: 280,
    value: (person) => person.name,
    render: (person, href) => (
      <Link
        to={href}
        className="flex min-w-0 items-center gap-2.5 rounded-sm text-[14px] font-medium text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
      >
        <span className="truncate">{person.name || "(unnamed)"}</span>
      </Link>
    ),
  },
  {
    id: "role",
    name: "Role",
    type: "text",
    icon: Briefcase,
    width: 220,
    value: (person) => person.role,
  },
  {
    id: "company",
    name: "Company",
    type: "text",
    icon: Building2,
    width: 200,
    value: (person) => person.company,
  },
  {
    id: "email",
    name: "Email",
    type: "text",
    icon: Mail,
    width: 260,
    mono: true,
    value: (person) => person.email,
  },
  {
    id: "area",
    name: "Area",
    type: "select",
    icon: FolderKanban,
    width: 160,
    value: (person) => person.area ?? null,
  },
  {
    id: "created",
    name: "Created",
    type: "date",
    icon: CalendarDays,
    width: 170,
    value: (person) => person.created ?? "",
  },
  {
    id: "updated",
    name: "Updated",
    type: "date",
    icon: CalendarClock,
    width: 170,
    value: (person) => person.updated ?? "",
  },
];

export function PeopleList() {
  const { data, isLoading } = useAllPeople();
  // Coerce explicitly: destructure-default only catches `undefined`, but
  // TanStack Query observers can briefly surface `null` (e.g. mid-refetch
  // with a query that select-projects to a nullable value on the same key —
  // usePerson does this). Using `?? []` covers both.
  const people = data ?? [];
  const { update, remove } = usePeopleMutations();
  const [adding, setAdding] = useState(false);
  const view = useRecordTableState(DEFAULT_SORTS);
  const columns = useMemo(() => withAreaOptions(people), [people]);

  return (
    <RecordTable
      title="People"
      unit="people"
      rows={people}
      columns={columns}
      loading={isLoading}
      rowKey={(person) => person.id}
      rowHref={(person) => `/people/${person.id}`}
      showViewTab={false}
      totalOnlyWhenUnfiltered
      quietEmptyCells
      searchPlaceholder="Search people"
      query={view.query}
      onQueryChange={view.setQuery}
      filters={view.filters}
      onFiltersChange={view.setFilters}
      sorts={view.sorts}
      onSortsChange={view.setSorts}
      hasActiveView={view.isDirty}
      onResetView={view.reset}
      onBulkDelete={(targets) =>
        Promise.all(targets.map((person) => remove.mutateAsync({ id: person.id })))
      }
      favorite={{
        isFavorite: (person) => person.favorite,
        onToggle: (person) =>
          update.mutate({
            id: person.id,
            update: { favorite: !person.favorite },
          }),
      }}
      emptyMessage="No people yet. Click + to add one."
      action={
        !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label="New person"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <Plus className="h-4 w-4" strokeWidth={1.7} />
          </button>
        )
      }
      aboveGrid={
        adding && (
          <div className="mb-4 max-w-md border-b border-border pb-6">
            <NewPersonForm
              onCreated={() => setAdding(false)}
              onCancel={() => setAdding(false)}
            />
          </div>
        )
      }
    />
  );
}

function withAreaOptions(people: PersonDto[]): RecordColumn<PersonDto>[] {
  const options = selectOptionsFromValues(
    people.map((person) => person.area ?? "").filter(Boolean),
  );
  return COLUMNS.map((column) =>
    column.id === "area" ? { ...column, options } : column,
  );
}
