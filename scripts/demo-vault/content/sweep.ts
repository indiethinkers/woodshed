import type { Calendar } from "../dates";
import {
  writeSweepCard,
  type SweepActionKind,
  type SweepStatus,
  type VaultWriter,
} from "../emit";
import { FOUNDER } from "./narrative";
import { inboxMessageId, type MailIndex } from "./mail";

interface CardSeed {
  id: string;
  /** Slug of a message in `inbox/`. */
  emailSlug: string;
  status: SweepStatus;
  headline: string;
  summary: string;
  whatHappened: string;
  actionKind: SweepActionKind;
  actionLabel: string;
  actionTarget?: string;
  draft?: string;
  why: string[];
  createdOffset: number;
  createdTime: string;
  timeline: Array<{
    offset: number;
    time: string;
    actor: string;
    action: string;
    detail?: string;
  }>;
}

const CARDS: CardSeed[] = [
  {
    id: "sweep-northwind-retention",
    emailSlug: "northwind-partner-meeting",
    status: "to_review",
    headline: "Priya needs the retention cut before Thursday",
    summary:
      "Northwind's partner meeting is Thursday. Priya wants the retention breakdown by acquisition source and a direct answer on collaboration — both before the discussion, both rough is fine.",
    whatHappened:
      "Priya confirmed Thursday 2pm with the full partnership and listed two things she wants in front of the room. She notes she has been describing the retention cut secondhand since your first call, and that Halyard's pass on the collaboration question is known to the partnership.",
    actionKind: "reply",
    actionLabel: "Draft reply",
    draft: [
      "Both make sense — I'll have the retention cut with you Wednesday and the",
      "collaboration answer written up before Thursday rather than improvised in",
      "the room.",
    ].join("\n"),
    why: [
      "Decision meeting is in 3 days",
      "Retention cut has been outstanding since the first call",
      "Directly referenced by the open task on today's list",
    ],
    createdOffset: -1,
    createdTime: "17:50",
    timeline: [
      {
        offset: -1,
        time: "17:50",
        actor: "hermes",
        action: "triaged",
        detail: "recommend reply",
      },
    ],
  },
  {
    id: "sweep-jonas-rollout",
    emailSlug: "jonas-security-approved",
    status: "to_review",
    headline: "Ostrich passed security review — 60 seats, wants a failure-mode call",
    summary:
      "Jonas's reviewer signed off and they are rolling out to all 60 engineers. He wants an hour before the rollout to work through failure modes.",
    whatHappened:
      "The security document cleared the review — the reviewer specifically noted it enumerated network calls rather than describing a posture. Jonas is asking about vaults on network shares and the recovery story for a corrupted file.",
    actionKind: "task",
    actionLabel: "Create task",
    actionTarget: "Prepare the Ostrich rollout checklist",
    why: [
      "Largest single deployment to date",
      "Network-share question overlaps the open Quarry Labs thread",
      "Rollout call already on the calendar",
    ],
    createdOffset: -3,
    createdTime: "09:40",
    timeline: [
      {
        offset: -3,
        time: "09:40",
        actor: "hermes",
        action: "triaged",
        detail: "recommend task",
      },
    ],
  },
  {
    id: "sweep-ravi-revision",
    emailSlug: "ravi-index-latency",
    status: "queued",
    headline: "Ravi confirms the latency fix, asks about revision-before-write",
    summary:
      "Index warmup verified at 940 files. He wants to know whether the revision-before-direct-write follow-up is tracked.",
    whatHappened:
      "Ravi updated and could not reproduce the first-query pause. Separately he raised the open follow-up from the iCloud fix — writing a revision before the direct write, so a crash mid-write leaves a recoverable copy.",
    actionKind: "reply",
    actionLabel: "Send reply",
    draft: [
      "Confirmed on the latency — glad it held up at your vault size.",
      "",
      "The revision-before-write follow-up is tracked and not scheduled. Honest",
      "answer: it matters most on exactly your setup, so I'll move it up.",
    ].join("\n"),
    why: [
      "Design partner reference for Foundry Line",
      "Names a known open follow-up",
    ],
    createdOffset: -1,
    createdTime: "14:30",
    timeline: [
      {
        offset: -1,
        time: "14:30",
        actor: "hermes",
        action: "triaged",
        detail: "recommend reply",
      },
      {
        offset: -1,
        time: "15:02",
        actor: "you",
        action: "approved",
        detail: "queued for send",
      },
    ],
  },
  {
    id: "sweep-lena-yc",
    emailSlug: "lena-yc-answers",
    status: "working",
    headline: "Lena's edit: cut \"why now\" to one falsifiable sentence",
    summary:
      "Detailed edit on the YC draft. The \"why did you pick this idea\" answer should stay untouched; \"why now\" is three unfalsifiable claims and should become one.",
    whatHappened:
      "Lena read the full draft and returned line-level feedback. She also flagged that the competitors answer is too polite about why Obsidian will not ship first-party calendar and mail.",
    actionKind: "task",
    actionLabel: "Create task",
    actionTarget: "Cut the YC \"why now\" answer by a third",
    why: [
      "Application deadline is in 4 days",
      "Matches the in-progress task already on today's list",
    ],
    createdOffset: -4,
    createdTime: "20:20",
    timeline: [
      {
        offset: -4,
        time: "20:20",
        actor: "hermes",
        action: "triaged",
        detail: "recommend task",
      },
      { offset: -4, time: "21:00", actor: "you", action: "approved" },
      {
        offset: 0,
        time: "08:32",
        actor: "app",
        action: "task started",
        detail: "timer running",
      },
    ],
  },
  {
    id: "sweep-recruiter",
    emailSlug: "recruiter-spam",
    status: "done",
    headline: "Cold recruiter outreach",
    summary: "Generic VP Engineering pitch. No relationship, no context.",
    whatHappened:
      "Untargeted outreach from a recruiting agency. Nothing in the vault connects to this sender.",
    actionKind: "archive",
    actionLabel: "Archive",
    why: ["No prior thread", "No named person in the vault"],
    createdOffset: -6,
    createdTime: "13:10",
    timeline: [
      {
        offset: -6,
        time: "13:10",
        actor: "hermes",
        action: "triaged",
        detail: "recommend archive",
      },
      { offset: -6, time: "13:12", actor: "you", action: "approved" },
      { offset: -6, time: "13:12", actor: "app", action: "archived" },
    ],
  },
  {
    id: "sweep-invoice",
    emailSlug: "invoice-hosting",
    status: "done",
    headline: "Hosting invoice — $88.00",
    summary: "Monthly invoice for the marketing site and docs hosting. Due on receipt.",
    whatHappened:
      "Routine recurring invoice, same amount as the previous eleven months.",
    actionKind: "snooze",
    actionLabel: "Snooze",
    why: ["Recurring charge", "No action needed until the accounting review"],
    createdOffset: -8,
    createdTime: "07:05",
    timeline: [
      {
        offset: -8,
        time: "07:05",
        actor: "hermes",
        action: "triaged",
        detail: "recommend snooze",
      },
      {
        offset: -8,
        time: "07:30",
        actor: "you",
        action: "snoozed",
        detail: "until month end",
      },
    ],
  },
];

export function buildSweep(
  w: VaultWriter,
  cal: Calendar,
  mail: MailIndex,
): void {
  for (const card of CARDS) {
    const emailId = inboxMessageId(card.emailSlug);
    const source = mail.byId.get(emailId);
    if (!source) {
      throw new Error(`sweep card ${card.id} references unwritten email`);
    }
    // `to_review` cards whose email is not in inbox/ get pruned by
    // sweep_discard_orphans (commands/sweep.rs:239) on the next refresh, which
    // would delete them mid-demo. Binding to a real inbox message avoids that.
    writeSweepCard(w, {
      id: card.id,
      emailId,
      threadId: source.threadId,
      inbox: FOUNDER.inbox,
      from: source.from,
      subject: source.subject,
      emailDate: source.date,
      status: card.status,
      headline: card.headline,
      summary: card.summary,
      whatHappened: card.whatHappened,
      actionKind: card.actionKind,
      actionLabel: card.actionLabel,
      actionTarget: card.actionTarget,
      draft: card.draft,
      why: card.why,
      created: cal.at(card.createdOffset, card.createdTime),
      updated: cal.at(
        card.timeline[card.timeline.length - 1].offset,
        card.timeline[card.timeline.length - 1].time,
      ),
      timeline: card.timeline.map((event) => ({
        at: cal.at(event.offset, event.time),
        actor: event.actor,
        action: event.action,
        detail: event.detail,
      })),
    });
  }
}
