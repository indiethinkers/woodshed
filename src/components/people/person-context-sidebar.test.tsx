import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { PersonDto } from "@/lib/hooks/use-people";

const mocks = vi.hoisted(() => ({
  people: [] as PersonDto[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/lib/hooks/use-people", () => ({
  useAllPeople: () => ({ data: mocks.people }),
}));

vi.mock("@/lib/hooks/use-notes", () => ({
  useAllNotes: () => ({ data: [] }),
}));

vi.mock("@/lib/hooks/use-tasks", () => ({
  useAllTasks: () => ({ data: [] }),
}));

vi.mock("@/lib/hooks/use-tag-table", () => ({
  useTagTable: () => ({ data: [] }),
}));

vi.mock("@/lib/hooks/use-mail", () => ({
  useAllMail: () => ({ data: [] }),
  useMail: () => ({ data: [] }),
}));

vi.mock("@/lib/hooks/use-resources", () => ({
  useAllResources: () => ({ data: [] }),
}));

import { PeopleIndexSidebar } from "./person-context-sidebar";

function person(name: string, fields: Partial<PersonDto> = {}): PersonDto {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    path: `people/${name}.md`,
    name,
    initials: name.slice(0, 2).toUpperCase(),
    role: "",
    company: "",
    email: "",
    relationship: "",
    favorite: false,
    body: "",
    ...fields,
  };
}

describe("PeopleIndexSidebar", () => {
  beforeEach(() => {
    mocks.people = [
      person("Favorite", {
        favorite: true,
        role: "Founder",
        company: "Example",
        updated: "2025-03-01T08:00:00Z",
      }),
      person("Activity Person", { role: "Writer", company: "Studio" }),
      person("No Timestamp"),
    ];
  });

  it("renders favorites without a recent-activity section", () => {
    render(<PeopleIndexSidebar />);

    expect(
      screen.queryByRole("heading", { level: 2, name: "People" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "New person" })).toBeTruthy();
    expect(screen.getByText("Favorite")).toBeTruthy();
    expect(screen.getByText("Founder · Example")).toBeTruthy();
    expect(screen.queryByText("Most recent")).toBeNull();
    expect(screen.queryByText("Activity Person")).toBeNull();
    expect(screen.queryByText("Writer · Studio")).toBeNull();
    expect(screen.queryByText("No Timestamp")).toBeNull();
  });
});
