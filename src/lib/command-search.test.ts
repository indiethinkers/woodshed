import { describe, expect, it } from "vitest";
import { compileResults, resolveActionItems } from "./command-search";

describe("resolveActionItems", () => {
  it("builds explicit note and task actions", () => {
    expect(resolveActionItems("note File over app")[0]).toMatchObject({
      kind: "action",
      label: "Create note “File over app”",
      action: { type: "create-note", title: "File over app" },
    });
    expect(resolveActionItems("task Follow up with Alex")[0]).toMatchObject({
      kind: "action",
      label: "Create task “Follow up with Alex”",
      action: { type: "create-task", content: "Follow up with Alex" },
    });
  });

  it("builds people, areas, and database actions from prefixed queries", () => {
    expect(resolveActionItems("person Ada Lovelace")[0]).toMatchObject({
      action: { type: "create-person", name: "Ada Lovelace" },
      hint: "People",
    });
    expect(resolveActionItems("area Browser Review")[0]).toMatchObject({
      action: { type: "create-area", name: "Browser Review" },
      hint: "Areas",
    });
    expect(resolveActionItems("table Reading List")[0]).toMatchObject({
      action: { type: "create-table", name: "Reading List" },
      hint: "Databases",
    });
  });

  it("captures URLs as resource actions", () => {
    expect(resolveActionItems("https://www.inkandswitch.com/local-first/")[0])
      .toMatchObject({
        label: "Save resource “inkandswitch.com”",
        hint: "inkandswitch.com",
        action: {
          type: "create-resource",
          title: "inkandswitch.com",
          url: "https://www.inkandswitch.com/local-first/",
          source: "inkandswitch.com",
        },
      });
    expect(resolveActionItems("save https://example.com/a.")[0]).toMatchObject({
      action: {
        type: "create-resource",
        url: "https://example.com/a",
        source: "example.com",
      },
    });
  });

  it("does not create generic actions for ordinary search text", () => {
    expect(resolveActionItems("Alex")).toEqual([]);
  });
});

describe("compileResults", () => {
  it("keeps normal page search while adding explicit create actions", () => {
    const groups = compileResults({
      query: "note File over app",
      today: "2026-06-07",
      hits: [],
    });

    expect(groups).toEqual([
      expect.objectContaining({
        kind: "action",
        items: [
          expect.objectContaining({
            action: { type: "create-note", title: "File over app" },
          }),
        ],
      }),
    ]);

    const pageGroups = compileResults({
      query: "mail",
      today: "2026-06-07",
      hits: [],
    });

    const pageItems = pageGroups.flatMap((group) => group.items);
    expect(pageItems.some((item) => item.href === "/mail")).toBe(true);
  });

  it("orders vault-content groups by title-match strength", () => {
    // Query matches the area's title → Areas group leads, above People.
    const areaLeads = compileResults({
      query: "acme",
      today: "2026-06-07",
      hits: [
        { kind: "area", docId: "acme", title: "Acme", href: "/areas/acme" },
        { kind: "person", docId: "alex-rivera", title: "Alex Rivera", href: "/people/alex-rivera" },
      ],
    });
    const areaKinds = areaLeads.map((g) => g.kind);
    expect(areaKinds.indexOf("area")).toBeLessThan(areaKinds.indexOf("person"));

    // Query matches the person's title → People leads, above Areas. Same
    // kinds, opposite order — proves the ranking is match-driven, not
    // hardcoded.
    const personLeads = compileResults({
      query: "alex",
      today: "2026-06-07",
      hits: [
        { kind: "person", docId: "alex-rivera", title: "Alex Rivera", href: "/people/alex-rivera" },
        { kind: "area", docId: "acme", title: "Acme", href: "/areas/acme" },
      ],
    });
    const personKinds = personLeads.map((g) => g.kind);
    expect(personKinds.indexOf("person")).toBeLessThan(personKinds.indexOf("area"));
  });

  it("leads with a title-prefix match over higher-ranked fuzzy hits", () => {
    // FTS5 ranked two people above the area (they mention "acme" in
    // their body), but "acm" is a prefix of the area's title → the Areas
    // group leads anyway.
    const groups = compileResults({
      query: "acm",
      today: "2026-06-07",
      hits: [
        { kind: "person", docId: "p1", title: "Alex Rivera", href: "/people/p1" },
        { kind: "person", docId: "p2", title: "Ada Lovelace", href: "/people/p2" },
        { kind: "area", docId: "acme", title: "Acme", href: "/areas/acme" },
      ],
    });
    expect(groups[0]).toMatchObject({ kind: "area" });
    expect(groups[0].items[0]).toMatchObject({ href: "/areas/acme" });
  });

  it("floats the exact match to the first row within its group", () => {
    const groups = compileResults({
      query: "acme",
      today: "2026-06-07",
      hits: [
        { kind: "area", docId: "acme-labs", title: "Acme Labs", href: "/areas/acme-labs" },
        { kind: "area", docId: "acme", title: "Acme", href: "/areas/acme" },
      ],
    });
    const areaGroup = groups.find((g) => g.kind === "area")!;
    expect(areaGroup.items[0]).toMatchObject({ href: "/areas/acme" });
  });

  it("pins day/page/action groups above vault-content hits", () => {
    const groups = compileResults({
      query: "today",
      today: "2026-06-07",
      hits: [
        { kind: "area", docId: "acme", title: "Today's focus", href: "/areas/acme" },
      ],
    });
    expect(groups[0].kind).toBe("day");
  });

  it("orders weekday daily pages by proximity to today", () => {
    // Friday Aug 7 → next Monday is Aug 10, next Tuesday is Aug 11.
    // FTS5 returns Mondays in body-driven order; the palette should promote
    // the nearest upcoming date, then the most recent past.
    const monday = compileResults({
      query: "monday",
      today: "2026-08-07",
      hits: [
        { kind: "daily", docId: "2026-07-27", title: "Monday, July 27", hint: "2026-07-27", href: "/cadence/2026-07-27" },
        { kind: "daily", docId: "2026-07-06", title: "Monday, July 6", hint: "2026-07-06", href: "/cadence/2026-07-06" },
        { kind: "daily", docId: "2026-08-10", title: "Monday, August 10", hint: "2026-08-10", href: "/cadence/2026-08-10" },
        { kind: "daily", docId: "2026-05-04", title: "Monday, May 4", hint: "2026-05-04", href: "/cadence/2026-05-04" },
        { kind: "daily", docId: "2026-08-03", title: "Monday, August 3", hint: "2026-08-03", href: "/cadence/2026-08-03" },
        { kind: "daily", docId: "2026-08-17", title: "Monday, August 17", hint: "2026-08-17", href: "/cadence/2026-08-17" },
      ],
    });
    const mondayDates = monday
      .find((g) => g.kind === "daily")!
      .items.map((item) => item.hint);
    expect(mondayDates).toEqual([
      "2026-08-10",
      "2026-08-17",
      "2026-08-03",
      "2026-07-27",
      "2026-07-06",
      "2026-05-04",
    ]);

    const tuesday = compileResults({
      query: "tuesday",
      today: "2026-08-07",
      hits: [
        { kind: "daily", docId: "2026-05-19", title: "Tuesday, May 19", hint: "2026-05-19", href: "/cadence/2026-05-19" },
        { kind: "daily", docId: "2026-08-11", title: "Tuesday, August 11", hint: "2026-08-11", href: "/cadence/2026-08-11" },
        { kind: "daily", docId: "2026-07-07", title: "Tuesday, July 7", hint: "2026-07-07", href: "/cadence/2026-07-07" },
        { kind: "daily", docId: "2026-08-04", title: "Tuesday, August 4", hint: "2026-08-04", href: "/cadence/2026-08-04" },
      ],
    });
    expect(tuesday.find((g) => g.kind === "daily")!.items[0]).toMatchObject({
      hint: "2026-08-11",
      href: "/cadence/2026-08-11",
    });
  });

  it("keeps a stronger daily title match ahead of a nearer date", () => {
    // Prefix of "Monday, May 4" beats the nearer Monday even though Aug 10
    // would win on proximity alone.
    const groups = compileResults({
      query: "monday, may",
      today: "2026-08-07",
      hits: [
        { kind: "daily", docId: "2026-08-10", title: "Monday, August 10", hint: "2026-08-10", href: "/cadence/2026-08-10" },
        { kind: "daily", docId: "2026-05-04", title: "Monday, May 4", hint: "2026-05-04", href: "/cadence/2026-05-04" },
      ],
    });
    expect(groups.find((g) => g.kind === "daily")!.items.map((i) => i.hint)).toEqual([
      "2026-05-04",
      "2026-08-10",
    ]);
  });

  it("renders custom database hits as Databases results", () => {
    const groups = compileResults({
      query: "project ledger",
      today: "2026-06-07",
      hits: [
        {
          kind: "table",
          docId: "project-ledger",
          title: "Project Ledger",
          href: "/databases/project-ledger",
        },
      ],
    });

    expect(groups).toEqual([
      expect.objectContaining({
        kind: "table",
        label: "Databases",
        items: [
          expect.objectContaining({
            href: "/databases/project-ledger",
            kind: "table",
          }),
        ],
      }),
    ]);
  });
});
