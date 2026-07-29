import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateAfterIndexRebuild, invalidateForPath } from "./vault-events";

describe("invalidateForPath", () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryClient = new QueryClient();
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  });

  it("routes tasks/<id>.md to ['task', id] and ['tasks']", () => {
    invalidateForPath(queryClient, "tasks/t_01HM3X.md");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["task", "t_01HM3X"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tasks"] });
  });

  it("routes events/<id>.md to ['event', id] and ['events']", () => {
    invalidateForPath(queryClient, "events/e_alex_01HM3Z.md");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["event", "e_alex_01HM3Z"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["events"] });
  });

  it("routes cadence/YYYY-MM-DD.md to ['dailyJournal', date] and per-date ['events', date]", () => {
    invalidateForPath(queryClient, "cadence/2026-04-25.md");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["dailyJournal", "2026-04-25"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["events", "2026-04-25"] });
    // Crucially, no broad ['events'] or ['event'] invalidation — journal
    // autosave fires on every keystroke, so a dragnet here would refetch
    // every cached date's events on every character.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["events"] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["event"] });
  });

  it("routes legacy cadence/<slug>.md to ['event'] and ['events']", () => {
    invalidateForPath(queryClient, "cadence/alex-1on1-2026-04-25.md");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["event"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["events"] });
  });

  it("also accepts legacy calendar/<slug>.md path during migration", () => {
    invalidateForPath(queryClient, "calendar/alex-1on1-2026-04-25.md");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["event"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["events"] });
  });

  it("routes daily/YYYY-MM-DD.md to ['dailyJournal', date]", () => {
    invalidateForPath(queryClient, "daily/2026-04-25.md");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["dailyJournal", "2026-04-25"],
    });
  });

  it("routes people/<id>.md to ['people'] (single-source list cache)", () => {
    invalidateForPath(queryClient, "people/jamie-parker.md");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["people"] });
    // No per-id cache exists; usePerson selects from the list. The list
    // refetch above is the only invalidation needed.
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ["person", "jamie-parker"],
    });
    // A person's name/email feeds server-side attendee resolution, so an
    // external person edit must also refresh event queries — otherwise an
    // open calendar page keeps showing a freshly-added contact as a plain
    // unresolved email.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["events"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["event"] });
  });

  it("treats a removed people/<id>.md the same as modified — list refetch settles it", () => {
    invalidateForPath(queryClient, "people/jamie-parker.md", "removed");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["people"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["events"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["event"] });
  });

  it("routes notebook/<id>.md to ['notes'] only (single-source list cache)", () => {
    invalidateForPath(queryClient, "notebook/file-over-app.md");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["notes"] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ["note", "file-over-app"],
    });
  });

  it("routes agent/<id>.md only through derived cache invalidations", () => {
    invalidateForPath(queryClient, "agent/agent_01HX.md");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["search"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["wikilinkTargets"] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["notes"] });
    expect(invalidateSpy).not.toHaveBeenCalledWith();
  });

  it("ignores Woodshed's hidden revision state", () => {
    invalidateForPath(
      queryClient,
      ".woodshed/revisions/agent/agent_01HX.md/20260725T215914.md",
    );
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("routes resources/<id>.md to ['resource', id] and ['resources']", () => {
    invalidateForPath(queryClient, "resources/file-over-app.md");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["resource", "file-over-app"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["resources"] });
  });

  it("routes areas/<id>.md to ['areas'] (coarse invalidation)", () => {
    invalidateForPath(queryClient, "areas/woodshed.md");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["areas"] });
  });

  it("falls back to coarse invalidation for unknown sections", () => {
    invalidateForPath(queryClient, "weird/path.md");
    expect(invalidateSpy).toHaveBeenCalledWith();
  });

  it("ignores paths without a section", () => {
    invalidateForPath(queryClient, "lonely.md");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("invalidateAfterIndexRebuild", () => {
  it("refreshes generated tag dates after a background rebuild", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    invalidateAfterIndexRebuild(queryClient);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["emails"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tagTable"] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["tagsWithCounts"],
    });
  });
});
