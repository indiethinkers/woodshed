import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ListSidebarSection } from "@/components/shared/list-sidebar";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/lib/hooks/use-outgoing-links", () => ({
  useOutgoingLinks: () => ({
    data: [
      {
        label: "Linked note",
        href: "/notebook/linked-note",
        resolved: true,
        title: "Linked note",
        type: "note",
      },
    ],
  }),
}));

vi.mock("@/lib/hooks/use-backlinks", () => ({
  useBacklinks: () => ({
    data: [
      {
        href: "/notebook/mentioning-note",
        title: "Mentioning note",
        preview: "A mention",
      },
    ],
  }),
}));

import { RecordContextSidebar } from "./record-context-sidebar";

function sectionLabels() {
  return screen
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent);
}

describe("RecordContextSidebar section order", () => {
  it("keeps the standard Links then Backlinks order by default", () => {
    render(<RecordContextSidebar id="person" title="Person" />);

    expect(sectionLabels()).toEqual(["Links", "Backlinks"]);
  });

  it("can lead with mentions and place a surface section immediately after", () => {
    render(
      <RecordContextSidebar
        id="person"
        title="Person"
        backlinksTitle="Mentioned in"
        backlinksFirst
        afterBacklinks={
          <ListSidebarSection label="Activity" count={1}>
            <p>Activity item</p>
          </ListSidebarSection>
        }
      />,
    );

    expect(sectionLabels()).toEqual(["Mentioned in", "Activity", "Links"]);
  });

  it("keeps a surface creation action available while a record is open", () => {
    render(
      <RecordContextSidebar
        id="person"
        title="Person"
        primaryAction={<button type="button">New person</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "New person" })).toBeTruthy();
  });
});
