import { describe, expect, it } from "vitest";
import { cardsByEmail, isSnoozed, laneForEmail, rowsByLane } from "./lanes";
import type { EmailSummary } from "../mail-lib/types";
import type { SweepCard } from "./types";

function card(partial: Partial<SweepCard>): SweepCard {
  return {
    id: "c",
    path: "",
    emailId: "e",
    from: "",
    subject: "",
    status: "to_review",
    headline: "",
    summary: "",
    whatHappened: "",
    actionKind: "reply",
    actionLabel: "",
    draft: "",
    why: [],
    created: "",
    updated: "",
    timeline: [],
    ...partial,
  };
}

function email(partial: Partial<EmailSummary>): EmailSummary {
  return {
    id: "e",
    threadId: "e",
    from: "",
    fromEmail: "",
    subject: "",
    body: "",
    html: null,
    preview: "",
    date: "",
    read: true,
    labels: [],
    mentions: [],
    links: [],
    inbox: "",
    path: "",
    attachments: [],
    ...partial,
  };
}

describe("lanes", () => {
  it("detects a future snooze", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(isSnoozed(card({ snoozeUntil: future }))).toBe(true);
    expect(isSnoozed(card({ snoozeUntil: past }))).toBe(false);
    expect(isSnoozed(card({}))).toBe(false);
  });

  it("maps emails to their cards", () => {
    const byEmail = cardsByEmail([card({ emailId: "a", status: "done" })]);
    expect(byEmail.get("a")?.status).toBe("done");
    expect(byEmail.has("b")).toBe(false);
  });

  it("derives an email's lane (untriaged falls into to_review)", () => {
    const byEmail = cardsByEmail([card({ emailId: "a", status: "done" })]);
    expect(laneForEmail("a", byEmail)).toBe("done");
    expect(laneForEmail("unknown", byEmail)).toBe("to_review");
  });

  it("hides a snoozed to_review email", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const byEmail = cardsByEmail([
      card({ emailId: "a", status: "to_review", snoozeUntil: future }),
    ]);
    expect(laneForEmail("a", byEmail)).toBeNull();
  });

  it("keeps done cards visible without an inbox email", () => {
    const rows = rowsByLane([], [card({ emailId: "archived", status: "done" })]);
    expect(rows.done.map((row) => row.id)).toEqual(["archived"]);
    expect(rows.done[0].email).toBeNull();
  });

  it("drops an orphaned to_review card whose email left the inbox", () => {
    const rows = rowsByLane([], [card({ emailId: "handled", status: "to_review" })]);
    expect(rows.to_review).toHaveLength(0);
  });

  it("keeps a to_review card whose email is still in the inbox", () => {
    const rows = rowsByLane(
      [email({ id: "pending" })],
      [card({ emailId: "pending", status: "to_review" })],
    );
    expect(rows.to_review.map((row) => row.id)).toEqual(["pending"]);
  });

  it("puts emails without cards into review", () => {
    const rows = rowsByLane([email({ id: "untriaged" })], []);
    expect(rows.to_review.map((row) => row.id)).toEqual(["untriaged"]);
    expect(rows.done).toHaveLength(0);
  });
});
