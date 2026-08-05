import { describe, expect, it } from "vitest";
import { buildPersonActivity, personLabels } from "./activity";
import type { EventDto } from "@/lib/hooks/use-events";
import type { NoteDto } from "@/lib/hooks/use-notes";
import type { PersonDto } from "@/lib/hooks/use-people";
import type { ResourceDto } from "@/lib/hooks/use-resources";
import type { TagTableRow } from "@/lib/hooks/use-tag-table";
import type { TaskDto } from "@/lib/hooks/use-tasks";
import type { EmailSummary } from "@/lib/mail-lib/types";

const person: PersonDto = {
  id: "ada-lovelace",
  path: "people/ada-lovelace.md",
  name: "Ada Lovelace",
  initials: "AL",
  role: "",
  company: "",
  email: "ada@example.com",
  relationship: "",
  favorite: false,
  body: "",
};

describe("personLabels", () => {
  it("indexes id, name, slug, and email", () => {
    expect(personLabels(person)).toEqual([
      "ada-lovelace",
      "ada lovelace",
      "ada@example.com",
    ]);
  });
});

describe("buildPersonActivity", () => {
  it("collects matching mail, events, tasks, and notes newest first", () => {
    const items = buildPersonActivity({
      person,
      now: "2026-06-09T00:00:00Z",
      emails: [
        email({
          id: "m1",
          fromEmail: "ada@example.com",
          subject: "Inbox question",
          date: "2026-06-07T16:00:00Z",
        }),
      ],
      eventRows: [
        eventRow({
          id: "e1",
          title: "Planning",
          date: "2026-06-07T10:00:00Z",
          event: event({ resolvedAttendees: [{ raw: "ada@example.com", name: "Ada", email: "ada@example.com" }] }),
        }),
      ],
      tasks: [
        task({
          id: "t1",
          content: "Follow up with [[Ada Lovelace]]",
          scheduled: "2026-06-08",
        }),
      ],
      notes: [
        note({
          id: "n1",
          title: "Meeting notes",
          body: "Discussed [[ada-lovelace]] and the engine.",
          created: "2026-06-06T12:00:00Z",
        }),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual([
      "task",
      "mail",
      "event",
      "note",
    ]);
    expect(items.map((item) => item.href)).toEqual([
      "/cadence/2026-06-08/task/t1",
      "/mail/m1",
      "/cadence/event/e1",
      "/notebook/n1",
    ]);
  });

  it("keeps recent activity ahead of upcoming events when limiting", () => {
    const items = buildPersonActivity({
      person,
      now: "2026-06-07T17:00:00Z",
      limit: 2,
      emails: [],
      tasks: [],
      notes: [
        note({
          id: "n1",
          title: "Fresh note",
          body: "[[Ada Lovelace]] follow-up",
          created: "2026-06-07T16:30:00Z",
        }),
      ],
      eventRows: [
        eventRow({
          id: "dec",
          title: "Future offsite",
          date: "2026-12-14T10:00:00Z",
          event: event({
            date: "2026-12-14T10:00:00Z",
            resolvedAttendees: [{ raw: "ada@example.com", name: "Ada", email: "ada@example.com" }],
          }),
        }),
        eventRow({
          id: "tomorrow",
          title: "Upcoming standup",
          date: "2026-06-08T10:00:00Z",
          event: event({
            date: "2026-06-08T10:00:00Z",
            resolvedAttendees: [{ raw: "ada@example.com", name: "Ada", email: "ada@example.com" }],
          }),
        }),
      ],
    });

    expect(items.map((item) => item.title)).toEqual([
      "Fresh note",
      "Upcoming standup",
    ]);
  });

  it("does not match plain-text mentions without wikilinks", () => {
    const items = buildPersonActivity({
      person,
      emails: [],
      eventRows: [],
      tasks: [task({ content: "Follow up with Ada Lovelace" })],
      notes: [note({ body: "Ada Lovelace came up." })],
    });

    expect(items).toEqual([]);
  });

  it("includes resources whose people include the person", () => {
    const items = buildPersonActivity({
      person,
      emails: [],
      eventRows: [],
      tasks: [],
      notes: [],
      resources: [
        resource({
          id: "by-author",
          title: "On Difference Engines",
          people: ["ada-lovelace"],
          capturedAt: "2026-06-08T09:00:00Z",
        }),
        resource({
          id: "by-name",
          title: "Notes on the Analytical Engine",
          people: ["Ada Lovelace"],
          capturedAt: "2026-06-07T09:00:00Z",
        }),
        resource({
          id: "by-mention",
          title: "Computing history",
          body: "Quotes [[ada-lovelace]] at length.",
          capturedAt: "2026-06-06T09:00:00Z",
        }),
        resource({
          id: "unrelated",
          title: "Unrelated",
          people: ["someone-else"],
        }),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual([
      "resource",
      "resource",
      "resource",
    ]);
    expect(items.map((item) => item.id)).toEqual([
      "resource:by-author",
      "resource:by-name",
      "resource:by-mention",
    ]);
    expect(items[0]).toMatchObject({
      title: "On Difference Engines",
      href: "/resources/by-author",
    });
  });

  it("matches iCal event attendees by person id and builds occurrence links", () => {
    const items = buildPersonActivity({
      person,
      emails: [],
      notes: [],
      tasks: [],
      eventRows: [
        eventRow({
          id: "ical-1",
          event: event({
            provider: "ical",
            accountId: "gcal_1",
            externalId: "abc",
            resolvedAttendees: [{ raw: "Ada Lovelace", personId: "ada-lovelace", name: "Ada" }],
          }),
        }),
      ],
    });

    expect(items[0]).toMatchObject({
      kind: "event",
      href: "/cadence/event/ical/gcal_1/abc?date=2026-06-07",
    });
  });
});

function email(overrides: Partial<EmailSummary> = {}): EmailSummary {
  return {
    id: "message",
    threadId: "thread",
    from: "Ada Lovelace",
    fromEmail: "ada@example.com",
    subject: "Subject",
    body: "",
    html: null,
    preview: "Preview",
    date: "2026-06-07T12:00:00Z",
    read: false,
    labels: [],
    mentions: [],
    links: [],
    inbox: "gmail:me@example.com",
    path: "inbox/message.md",
    attachments: [],
    ...overrides,
  };
}

function eventRow(overrides: Partial<TagTableRow> = {}): TagTableRow {
  return {
    id: "event",
    title: "Event",
    type: "event",
    date: "2026-06-07T09:00:00Z",
    area: "woodshed",
    path: "events/event.md",
    event: event(),
    ...overrides,
  };
}

function event(overrides: Partial<EventDto> = {}): EventDto {
  return {
    id: "event",
    path: "events/event.md",
    title: "Event",
    date: "2026-06-07T09:00:00Z",
    duration: 30,
    area: "woodshed",
    attendees: [],
    resolvedAttendees: [],
    recurring: "none",
    body: "",
    ...overrides,
  };
}

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "task",
    path: "tasks/task.md",
    content: "Task",
    status: "backlog",
    area: "woodshed",
    created: "2026-06-07T10:00:00Z",
    tags: [],
    timeSpentSeconds: 0,
    sortKey: 1,
    body: "",
    ...overrides,
  };
}

function note(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "note",
    path: "notebook/note.md",
    revision: "rev-note",
    title: "Note",
    created: "2026-06-07T08:00:00Z",
    tags: [],
    favorite: false,
    body: "",
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceDto> = {}): ResourceDto {
  return {
    id: "resource",
    path: "resources/resource.md",
    title: "Resource",
    url: "https://example.com/resource",
    source: "example.com",
    saved: "2026-06-07T08:00:00Z",
    people: [],
    tags: [],
    highlights: [],
    favorite: false,
    body: "",
    ...overrides,
  };
}
