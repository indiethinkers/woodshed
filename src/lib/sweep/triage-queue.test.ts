import { describe, expect, it } from "vitest";
import type { EmailSummary } from "@/lib/mail-lib/types";
import { pendingEmailIds, runTriageQueue } from "./triage-queue";
import type { SweepCard } from "./types";

function email(id: string): EmailSummary {
  return {
    id,
    threadId: "",
    from: "",
    fromEmail: "",
    subject: "",
    body: "",
    html: null,
    preview: "",
    date: "",
    read: false,
    labels: [],
    mentions: [],
    links: [],
    inbox: "",
    path: "",
    attachments: [],
  };
}

function card(emailId: string): SweepCard {
  return {
    id: `c-${emailId}`,
    path: "",
    emailId,
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
  };
}

describe("triage-queue", () => {
  it("finds emails without a card", () => {
    expect(pendingEmailIds([email("a"), email("b")], [card("a")])).toEqual(["b"]);
  });

  it("runs every id with bounded concurrency", async () => {
    const seen: string[] = [];
    await runTriageQueue(
      ["a", "b", "c"],
      async (id) => {
        seen.push(id);
      },
      { concurrency: 2 },
    );
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  });

  it("continues past a failed id", async () => {
    const ok: string[] = [];
    await runTriageQueue(["a", "b"], async (id) => {
      if (id === "a") throw new Error("boom");
      ok.push(id);
    });
    expect(ok).toEqual(["b"]);
  });

  it("stops early when aborted", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    await runTriageQueue(
      ["a", "b", "c"],
      async (id) => {
        seen.push(id);
        controller.abort();
      },
      { concurrency: 1, signal: controller.signal },
    );
    expect(seen).toEqual(["a"]);
  });
});
