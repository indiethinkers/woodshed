import type { Calendar, Weekday } from "../dates";
import {
  writeDaily,
  writeEvent,
  writeTask,
  type EventInput,
  type TaskInput,
  type VaultWriter,
} from "../emit";
import { AREA, FIRMS, METRICS, RAISE } from "./narrative";
import type { PersonRecord } from "./people";

const MONDAY: Weekday = 1;
const TUESDAY: Weekday = 2;
const WEDNESDAY: Weekday = 3;
const THURSDAY: Weekday = 4;
const FRIDAY: Weekday = 5;
const SATURDAY_W: Weekday = 6;

/**
 * A weekly meeting, stored once and projected forward at read time
 * (`occurrence_for` in commands/events.rs:1109). Weekly recurrence matches on
 * weekday, so these never land on a weekend — unlike `daily`, which would put a
 * standup on Saturday.
 */
interface SeriesSeed {
  id: string;
  title: string;
  weekday: Weekday;
  time: string;
  duration: number;
  area: string;
  attendees: string[];
  tags?: string[];
  body: string;
}

const SERIES: SeriesSeed[] = [
  {
    id: "e-series-1on1-alex",
    title: "1:1 with Alex Rivera",
    weekday: MONDAY,
    time: "09:30",
    duration: 30,
    area: AREA.product,
    attendees: ["alex-rivera"],
    tags: ["1on1"],
    body: [
      "Standing 1:1. Alex sets the agenda.",
      "",
      "Recurring topics: the write path, whatever the watcher is doing wrong this",
      "week, and runway — which he is entitled to ask about every time.",
    ].join("\n"),
  },
  {
    id: "e-series-1on1-sam",
    title: "1:1 with Sam Chen",
    weekday: TUESDAY,
    time: "09:30",
    duration: 30,
    area: AREA.product,
    attendees: ["sam-chen"],
    tags: ["1on1"],
    body: [
      "Standing 1:1. Mostly about what to *not* build.",
      "",
      "Sam is carrying frontend work on top of leading, which is not sustainable",
      "past the round closing. See [[Hiring plan (post-close)]].",
    ].join("\n"),
  },
  {
    id: "e-series-1on1-morgan",
    title: "1:1 with Morgan Diaz",
    weekday: THURSDAY,
    time: "09:30",
    duration: 30,
    area: AREA.product,
    attendees: ["morgan-diaz"],
    tags: ["1on1"],
    body: "Standing 1:1. Index, tag edges, and query performance on large vaults.",
  },
  {
    id: "e-series-1on1-casey",
    title: "1:1 with Casey Kim",
    weekday: WEDNESDAY,
    time: "15:00",
    duration: 30,
    area: AREA.product,
    attendees: ["casey-kim"],
    tags: ["1on1"],
    body: [
      "Standing 1:1. Currently all onboarding — see",
      "[[RFC — onboarding starts with import]].",
    ].join("\n"),
  },
  {
    id: "e-series-design-review",
    title: "Design review",
    weekday: WEDNESDAY,
    time: "11:00",
    duration: 60,
    area: AREA.product,
    attendees: ["sam-chen", "morgan-diaz", "casey-kim", "alex-rivera"],
    body: [
      "Weekly design review. One RFC per session, failure modes written down before",
      "anything ships.",
      "",
      "Notes go in the occurrence, not here.",
    ].join("\n"),
  },
  {
    id: "e-series-weekly-planning",
    title: "Weekly planning",
    weekday: FRIDAY,
    time: "16:00",
    duration: 45,
    area: AREA.product,
    attendees: [],
    body: [
      "Close the week. Move what did not happen, delete what will never happen, and",
      "write the week-in-review entry.",
    ].join("\n"),
  },
  {
    id: "e-series-climbing-tue",
    title: "Climbing with Nora Whitcomb",
    weekday: TUESDAY,
    time: "18:30",
    duration: 90,
    area: AREA.personal,
    attendees: ["nora-whitcomb"],
    body: "Non-negotiable. The only reliable structure in a fundraise week.",
  },
  {
    id: "e-series-climbing-thu",
    title: "Climbing with Nora Whitcomb",
    weekday: THURSDAY,
    time: "18:30",
    duration: 90,
    area: AREA.personal,
    attendees: ["nora-whitcomb"],
    body: "Second session. See [[Base fitness for climbers who sit down all day]].",
  },
  {
    id: "e-series-walk-jamie",
    title: "Walk with Jamie Parker",
    weekday: SATURDAY_W,
    time: "10:00",
    duration: 90,
    area: AREA.personal,
    attendees: ["jamie-parker"],
    body: [
      "Standing Saturday walk. No agenda, and explicitly not about the company —",
      "which is the entire point of it being on the calendar.",
    ].join("\n"),
  },
];

/** A dated, non-recurring event tied to a narrative beat. */
interface OneOffSeed {
  id: string;
  offset: number;
  title: string;
  time: string;
  duration: number;
  area: string;
  attendees?: string[];
  tags?: string[];
  body?: string;
}

const ONE_OFFS: OneOffSeed[] = [
  // ── Weeks −8 to −6: deciding to raise ────────────────────────────────────
  {
    id: "e-lena-should-i-raise",
    offset: -55,
    title: "Lena Fischer — should I raise?",
    time: "14:00",
    duration: 60,
    area: AREA.fundraise,
    attendees: ["lena-fischer"],
    tags: ["fundraise"],
    body: [
      "The conversation that started it. Lena's position: the traction supports a",
      "seed, but only if the pitch leads with the file format rather than the",
      "feature list.",
      "",
      'Her line, written down verbatim: "You are not selling a note app. You are',
      'selling the claim that the files outlive the company."',
      "",
      "That became the opening of [[Seed investor memo]].",
    ].join("\n"),
  },
  {
    id: "e-memo-writing-block",
    offset: -54,
    title: "Deep work — draft the memo",
    time: "07:30",
    duration: 180,
    area: AREA.fundraise,
    tags: ["fundraise"],
    body: "Three hours, no calls. Output: [[Seed investor memo]] first draft.",
  },
  {
    id: "e-oskar-intro-call",
    offset: -52,
    title: "Oskar Lindqvist — intro call",
    time: "11:00",
    duration: 30,
    area: AREA.fundraise,
    attendees: ["oskar-lindqvist"],
    tags: ["fundraise"],
    body: [
      "Northwind scout. Found us through the file-over-app essay, not through any",
      "outbound effort.",
      "",
      "Offered to introduce [[Priya Raman]] before I asked. Said yes immediately.",
    ].join("\n"),
  },
  {
    id: "e-target-list-session",
    offset: -50,
    title: "Build the target list",
    time: "16:00",
    duration: 90,
    area: AREA.fundraise,
    tags: ["fundraise"],
    body: [
      "Eighteen firms down to eleven. Cut anyone who has publicly written that",
      "productivity tools are not venture-scale — no point spending a first meeting",
      "arguing a prior.",
      "",
      "Became the Investor Pipeline table.",
    ].join("\n"),
  },

  // ── Weeks −5 to −3: first partner calls ──────────────────────────────────
  {
    id: "e-priya-first-call",
    offset: -44,
    title: "Priya Raman — first call",
    time: "13:00",
    duration: 45,
    area: AREA.fundraise,
    attendees: ["priya-raman"],
    tags: ["fundraise"],
    body: [
      "Excellent call. She had read the changelog before dialling in and asked about",
      "the FTS index design in the first ten minutes, unprompted.",
      "",
      "Pushed hardest on retention. I gave the aggregate number and she immediately",
      "asked for the cut by acquisition source, which I did not have. Fix before the",
      "next one — see [[Retention — what the number actually says]].",
      "",
      "Wants a second call with the full partnership.",
    ].join("\n"),
  },
  {
    id: "e-halyard-first",
    offset: -42,
    title: `Tomas Bergström — ${FIRMS.halyard}`,
    time: "10:00",
    duration: 45,
    area: AREA.fundraise,
    attendees: ["tomas-bergstrom"],
    tags: ["fundraise"],
    body: [
      "Sharp, sceptical, fair. Spent most of the call on the collaboration question.",
      "",
      "I answered it defensively. Should have answered it directly.",
    ].join("\n"),
  },
  {
    id: "e-ana-call",
    offset: -40,
    title: "Ana Ferreira — Ridgeline",
    time: "15:30",
    duration: 30,
    area: AREA.fundraise,
    attendees: ["ana-ferreira"],
    tags: ["fundraise"],
    body: [
      "Committed $250k on the call. No second meeting, no information rights, no",
      "process.",
      "",
      "Having one committed check changed the tone of every conversation after this.",
    ].join("\n"),
  },
  {
    id: "e-daniel-first-call",
    offset: -38,
    title: "Daniel Osei — first call",
    time: "11:00",
    duration: 60,
    area: AREA.fundraise,
    attendees: ["daniel-osei"],
    tags: ["fundraise"],
    body: [
      "Ex-operator who shipped a sync engine and regretted it. Unusually specific",
      "questions about what breaks under conflict.",
      "",
      "Asked for a design partner reference and named [[Ravi Menon]] himself after",
      "spotting Cartogram on the deck.",
    ].join("\n"),
  },
  {
    id: "e-halyard-second",
    offset: -36,
    title: `Tomas Bergström — second call`,
    time: "14:00",
    duration: 45,
    area: AREA.fundraise,
    attendees: ["tomas-bergstrom"],
    tags: ["fundraise"],
    body: "Same ground as the first call. Did not go well. Expecting a pass.",
  },
  {
    id: "e-nadia-angel",
    offset: -35,
    title: "Nadia Haddad — angel call",
    time: "09:00",
    duration: 30,
    area: AREA.fundraise,
    attendees: ["nadia-haddad"],
    tags: ["fundraise"],
    body: [
      "Committed $50k. Spent the rest of the call taking apart the onboarding flow,",
      "which was more valuable than the check.",
      "",
      "Her criticism: the vault picker asks for a commitment before the user knows",
      "what a vault is. Correct, and it became",
      "[[RFC — onboarding starts with import]].",
    ].join("\n"),
  },
  {
    id: "e-priya-partnership",
    offset: -30,
    title: `Priya Raman — ${FIRMS.northwind} partnership`,
    time: "13:00",
    duration: 60,
    area: AREA.fundraise,
    attendees: ["priya-raman"],
    tags: ["fundraise"],
    body: [
      "Full partnership meeting. Went long, which I am told is good.",
      "",
      "The retention cut landed — presenting it as \"users who arrive with material",
      "stay, users who start empty do not\" turned a soft number into a product",
      "decision, and the room engaged with it as such.",
      "",
      "Next step: diligence, then a partner meeting to decide.",
    ].join("\n"),
  },
  {
    id: "e-halyard-pass",
    offset: -21,
    title: "Tomas Bergström — pass",
    time: "17:00",
    duration: 15,
    area: AREA.fundraise,
    attendees: ["tomas-bergstrom"],
    tags: ["fundraise"],
    body: [
      "Fifteen minutes, delivered directly rather than by email. Respect that.",
      "",
      "Written up in [[Halyard passed — postmortem]].",
    ].join("\n"),
  },

  // ── Weeks −2 to −1: diligence ─────────────────────────────────────────────
  {
    id: "e-mei-diligence",
    offset: -18,
    title: "Mei Watanabe — diligence kickoff",
    time: "10:00",
    duration: 45,
    area: AREA.fundraise,
    attendees: ["mei-watanabe"],
    tags: ["fundraise", "dd"],
    body: [
      "Foundry Line's process runs through Mei, not Daniel.",
      "",
      "Requests: cohort retention by acquisition source, the paid-beta conversion",
      "numbers, and two design partner references. All reasonable, all things we",
      "should already have had assembled.",
    ].join("\n"),
  },
  {
    id: "e-jonas-security",
    offset: -27,
    title: "Jonas Klein — security review",
    time: "10:00",
    duration: 45,
    area: AREA.product,
    attendees: ["jonas-klein"],
    tags: ["dd"],
    body: [
      "Not an investor call but the most consequential meeting of the week.",
      "",
      "He needs an enumerable answer to \"when does data leave the machine\". Wrote",
      "[[When does data leave the machine?]] the same afternoon. It unblocked a",
      "60-person deployment.",
    ].join("\n"),
  },
  {
    id: "e-ravi-reference",
    offset: -4,
    title: "Ravi Menon — reference call for Foundry Line",
    time: "14:00",
    duration: 30,
    area: AREA.fundraise,
    attendees: ["ravi-menon"],
    tags: ["fundraise", "dd"],
    body: [
      "Ravi took the reference call with [[Daniel Osei]].",
      "",
      "Apparently spent twenty minutes on the iCloud data-loss bug and how it was",
      "handled — which is the best possible reference, and not the one I would have",
      "chosen to give.",
    ].join("\n"),
  },
  {
    id: "e-sofia-reference",
    offset: -3,
    title: "Sofia Duarte — reference call",
    time: "11:00",
    duration: 30,
    area: AREA.fundraise,
    attendees: ["sofia-duarte"],
    tags: ["fundraise", "dd"],
    body: "Second reference for Foundry Line. Sofia offered before being asked.",
  },
  {
    id: "e-metrics-assembly",
    offset: -17,
    title: "Assemble the diligence pack",
    time: "08:00",
    duration: 180,
    area: AREA.fundraise,
    tags: ["fundraise", "dd"],
    body: [
      "Cohort retention, conversion, burn. Built the Metrics table properly instead",
      "of rebuilding a spreadsheet every time someone asks.",
      "",
      "Output fed [[Retention — what the number actually says]].",
    ].join("\n"),
  },

  // ── Forward: scheduled ────────────────────────────────────────────────────
  {
    id: "e-northwind-partner-meeting",
    offset: 3,
    title: `Priya Raman — ${FIRMS.northwind} partner meeting`,
    time: "14:00",
    duration: 90,
    area: AREA.fundraise,
    attendees: ["priya-raman"],
    tags: ["fundraise"],
    body: [
      "The decision meeting.",
      "",
      "Bring: the retention cut, the security document, and a direct answer to the",
      "collaboration question — see [[RFC — shared vaults (sketch)]]. Do not",
      "improvise that one.",
      "",
      "Prep is [[Demo script — what to actually show]].",
    ].join("\n"),
  },
  {
    id: "e-yc-deadline",
    offset: 4,
    title: "YC W27 application deadline",
    time: "20:00",
    duration: 15,
    area: AREA.fundraise,
    tags: ["fundraise"],
    body: [
      "Hard deadline. [[YC W27 application — draft answers]] still needs the \"why",
      "now\" answer cut by a third.",
    ].join("\n"),
  },
  {
    id: "e-daniel-term-sheet",
    offset: 7,
    title: "Daniel Osei — terms conversation",
    time: "11:00",
    duration: 60,
    area: AREA.fundraise,
    attendees: ["daniel-osei"],
    tags: ["fundraise"],
    body: [
      "Foundry Line moving to terms, assuming references land.",
      "",
      "Read [[How post-money SAFEs actually dilute you]] again before this. Do not",
      "agree to a second cap.",
    ].join("\n"),
  },
  {
    id: "e-ostrich-onboarding",
    offset: 8,
    title: "Jonas Klein — Ostrich rollout",
    time: "15:00",
    duration: 60,
    area: AREA.product,
    attendees: ["jonas-klein"],
    body: "Sixty-seat deployment kickoff, unblocked by the security document.",
  },
  {
    id: "e-meridian-onboarding",
    offset: 10,
    title: "Sofia Duarte — Meridian team rollout",
    time: "10:00",
    duration: 45,
    area: AREA.product,
    attendees: ["sofia-duarte"],
    body: "Twelve seats. Sofia is running the internal rollout herself.",
  },
  {
    id: "e-theo-launch-chat",
    offset: 12,
    title: "Theo Almeida — launch coverage",
    time: "13:00",
    duration: 30,
    area: AREA.growth,
    attendees: ["theo-almeida"],
    body: [
      "Timing conversation, not an interview. Coverage should land after the round",
      "closes, not before.",
    ].join("\n"),
  },
];

/** Events placed on demo day itself, so Cadence always opens populated. */
function demoDayEvents(cal: Calendar): OneOffSeed[] {
  const workday = !cal.isWeekend(0);
  return [
    {
      id: "e-today-deep-work",
      offset: 0,
      title: "Deep work — cut the YC application",
      time: workday ? "08:30" : "10:30",
      duration: 90,
      area: AREA.fundraise,
      tags: ["fundraise"],
      body: [
        "The \"why now\" answer is a third too long and reads like the memo.",
        "",
        "[[Notes on writing a strong accelerator application]] — every answer should",
        "be falsifiable. That is the cut to make.",
      ].join("\n"),
    },
    {
      id: "e-today-ravi-checkin",
      offset: 0,
      title: workday
        ? "Ravi Menon — design partner check-in"
        : "Review Ravi Menon's vault performance report",
      time: workday ? "11:00" : "13:00",
      duration: 30,
      area: AREA.product,
      attendees: workday ? ["ravi-menon"] : [],
      body: [
        "Index warmup shipped last week. Confirm the first-query pause is gone at",
        "his vault size (~900 files).",
        "",
        "Also: the revision-before-direct-write follow-up from",
        "[[RFC — iCloud direct-write fallback]] is still open.",
      ].join("\n"),
    },
    {
      id: "e-today-northwind-prep",
      offset: 0,
      title: "Prep — Northwind partner meeting",
      time: workday ? "14:00" : "15:30",
      duration: 60,
      area: AREA.fundraise,
      tags: ["fundraise"],
      body: [
        "Thursday is the decision meeting. Work through",
        "[[Demo script — what to actually show]] end to end, out loud, once.",
        "",
        "The collaboration answer is the one to rehearse. See",
        "[[Questions I still cannot answer well]].",
      ].join("\n"),
    },
    {
      id: "e-today-spc-dinner",
      offset: 0,
      title: "South Park Commons dinner",
      time: "18:30",
      duration: 120,
      area: AREA.fundraise,
      tags: ["fundraise"],
      body: [
        "Bring the laptop, not slides. Lead with the constraint rather than the",
        "traction — see [[South Park Commons — what to lead with]].",
        "",
        "The unsolved multi-device problem is the interesting thing to talk about",
        "here, not the thing to hide.",
      ].join("\n"),
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

interface TaskSeed {
  id: string;
  content: string;
  status: "backlog" | "in-progress" | "done";
  area: string;
  /** Day the task is scheduled onto. */
  offset: number;
  order: number;
  tags?: string[];
  timeSpentSeconds?: number;
  /** Set only on the single in-progress task, so the timer reads as running. */
  running?: boolean;
  body?: string;
}

const TASKS: TaskSeed[] = [
  // ── Demo day ─────────────────────────────────────────────────────────────
  {
    id: "t-today-yc-cut",
    content: "Cut the YC \"why now\" answer by a third",
    status: "in-progress",
    area: AREA.fundraise,
    offset: 0,
    order: 1,
    tags: ["task", "fundraise"],
    timeSpentSeconds: 2_820,
    running: true,
    body: [
      "Currently 210 words, needs to be under 140.",
      "",
      "Cut the second paragraph entirely — it restates the memo and adds nothing a",
      "reader of the first paragraph does not already have.",
    ].join("\n"),
  },
  {
    id: "t-today-retention-cut",
    content: "Send [[Priya Raman]] the retention cut by acquisition source",
    status: "backlog",
    area: AREA.fundraise,
    offset: 0,
    order: 2,
    tags: ["task", "fundraise", "dd"],
    body: "She asked on the first call. Overdue. Numbers are in the Metrics table.",
  },
  {
    id: "t-today-ravi-followup",
    content: "Confirm index warmup fixed first-query latency for [[Ravi Menon]]",
    status: "backlog",
    area: AREA.product,
    offset: 0,
    order: 3,
    tags: ["task"],
  },
  {
    id: "t-today-spc-prep",
    content: "Re-read [[South Park Commons — what to lead with]] before dinner",
    status: "backlog",
    area: AREA.fundraise,
    offset: 0,
    order: 4,
    tags: ["task", "fundraise"],
  },
  {
    id: "t-today-revision-write",
    content: "Write revision before direct write (iCloud crash window)",
    status: "backlog",
    area: AREA.product,
    offset: 0,
    order: 5,
    tags: ["task", "rfc"],
    body: [
      "Open follow-up from [[RFC — iCloud direct-write fallback]]. A crash mid-write",
      "currently leaves a partial file with no recoverable copy.",
      "",
      "Not urgent until it is.",
    ].join("\n"),
  },
  {
    id: "t-today-groceries",
    content: "Groceries before the dinner",
    status: "done",
    area: AREA.personal,
    offset: 0,
    order: 6,
    timeSpentSeconds: 1_500,
  },

  // ── Recent past ──────────────────────────────────────────────────────────
  {
    id: "t-security-doc",
    content: "Write the security model document for [[Jonas Klein]]",
    status: "done",
    area: AREA.product,
    offset: -27,
    order: 1,
    tags: ["task", "dd"],
    timeSpentSeconds: 7_200,
    body: "Became [[When does data leave the machine?]]. Unblocked 60 seats.",
  },
  {
    id: "t-diligence-pack",
    content: "Assemble the Foundry Line diligence pack",
    status: "done",
    area: AREA.fundraise,
    offset: -17,
    order: 1,
    tags: ["task", "fundraise", "dd"],
    timeSpentSeconds: 12_600,
  },
  {
    id: "t-index-warmup",
    content: "Ship index warm-up at launch",
    status: "done",
    area: AREA.product,
    offset: -26,
    order: 1,
    tags: ["task", "rfc"],
    timeSpentSeconds: 9_000,
    body: "[[RFC — warm the search index at launch]]. Shipped, measurably better.",
  },
  {
    id: "t-halyard-writeup",
    content: "Write up the Halyard pass while it is fresh",
    status: "done",
    area: AREA.fundraise,
    offset: -21,
    order: 2,
    tags: ["task", "fundraise"],
    timeSpentSeconds: 1_800,
  },
  {
    id: "t-onboarding-rfc",
    content: "Draft the onboarding-import RFC",
    status: "done",
    area: AREA.product,
    offset: -12,
    order: 1,
    tags: ["task", "rfc"],
    timeSpentSeconds: 5_400,
  },
  {
    id: "t-runway-math",
    content: "Give [[Alex Rivera]] the real runway number",
    status: "done",
    area: AREA.fundraise,
    offset: -31,
    order: 1,
    tags: ["task", "fundraise"],
    body: "Seven months without the round. Told him directly. [[Runway math, honestly]].",
  },
  {
    id: "t-board-view-review",
    content: "Design review — Databases board view",
    status: "done",
    area: AREA.product,
    offset: -10,
    order: 1,
    tags: ["task"],
    timeSpentSeconds: 3_600,
  },
  {
    id: "t-interview-iris",
    content: "Interview [[Iris Chen]]",
    status: "done",
    area: AREA.growth,
    offset: -13,
    order: 1,
    tags: ["task", "user-interview"],
    timeSpentSeconds: 1_800,
  },
  {
    id: "t-memo-draft",
    content: "Draft the seed memo",
    status: "done",
    area: AREA.fundraise,
    offset: -54,
    order: 1,
    tags: ["task", "fundraise"],
    timeSpentSeconds: 10_800,
  },
  {
    id: "t-target-list",
    content: "Cut the investor target list to eleven",
    status: "done",
    area: AREA.fundraise,
    offset: -50,
    order: 1,
    tags: ["task", "fundraise"],
    timeSpentSeconds: 5_400,
  },
  {
    id: "t-monthly-update",
    content: "Send the monthly investor update",
    status: "done",
    area: AREA.fundraise,
    offset: -5,
    order: 1,
    tags: ["task", "fundraise"],
    timeSpentSeconds: 2_700,
    body: `WAU ${METRICS.wauCurrent}, retention ${METRICS.weekFourRetention}%, MRR $${(METRICS.mrr / 1000).toFixed(1)}k. Same three, as always.`,
  },
  {
    id: "t-week-review",
    content: "Write the week-in-review",
    status: "done",
    area: AREA.personal,
    offset: -2,
    order: 1,
    timeSpentSeconds: 900,
  },
  {
    id: "t-demo-script",
    content: "Write the demo script",
    status: "done",
    area: AREA.fundraise,
    offset: -3,
    order: 1,
    tags: ["task", "fundraise"],
    timeSpentSeconds: 3_600,
  },

  // ── Scheduled forward ────────────────────────────────────────────────────
  {
    id: "t-fwd-partner-prep",
    content: "Rehearse the collaboration answer out loud",
    status: "backlog",
    area: AREA.fundraise,
    offset: 1,
    order: 1,
    tags: ["task", "fundraise"],
    body: "The one question I still improvise. [[RFC — shared vaults (sketch)]].",
  },
  {
    id: "t-fwd-demo-dry-run",
    content: "Dry run [[Demo script — what to actually show]] end to end",
    status: "backlog",
    area: AREA.fundraise,
    offset: 2,
    order: 1,
    tags: ["task", "fundraise"],
  },
  {
    id: "t-fwd-yc-submit",
    content: "Submit the YC application",
    status: "backlog",
    area: AREA.fundraise,
    offset: 4,
    order: 1,
    tags: ["task", "fundraise"],
    body: "Hard deadline 20:00. Do not leave this to the evening of.",
  },
  {
    id: "t-fwd-safe-read",
    content: "Re-read the SAFE dilution piece before the terms call",
    status: "backlog",
    area: AREA.fundraise,
    offset: 6,
    order: 1,
    tags: ["task", "fundraise"],
  },
  {
    id: "t-fwd-ostrich-rollout",
    content: "Prepare the Ostrich rollout checklist",
    status: "backlog",
    area: AREA.product,
    offset: 7,
    order: 1,
    tags: ["task"],
  },
  {
    id: "t-fwd-iris-thanks",
    content: "Work out how to actually compensate [[Iris Chen]]",
    status: "backlog",
    area: AREA.growth,
    offset: 9,
    order: 1,
    tags: ["task"],
    body: [
      "She has done four months of community management for free. \"After the round\"",
      "has been the answer for too long.",
    ].join("\n"),
  },
  {
    id: "t-fwd-grace-engage",
    content: "Engage [[Grace Lin]] once the round closes",
    status: "backlog",
    area: AREA.growth,
    offset: 11,
    order: 1,
    tags: ["task", "hiring"],
    body: "Not before. [[Hiring plan (post-close)]].",
  },
  {
    id: "t-fwd-changelog",
    content: "Write the changelog properly, not from commits",
    status: "backlog",
    area: AREA.growth,
    offset: 13,
    order: 1,
    tags: ["task"],
    body: "[[The changelog is the product page]].",
  },

  // ── Unscheduled backlog ──────────────────────────────────────────────────
  {
    id: "t-backlog-pricing",
    content: "Do actual willingness-to-pay work on pricing",
    status: "backlog",
    area: AREA.growth,
    offset: 5,
    order: 2,
    tags: ["task", "positioning"],
    body: "$20/month is an anchor, not a finding. Someone will push on this.",
  },
  {
    id: "t-backlog-recurring-notes",
    content: "Thread recurring-meeting notes across occurrences",
    status: "backlog",
    area: AREA.product,
    offset: 5,
    order: 3,
    tags: ["task"],
    body: "[[Sofia Duarte]]'s ask. Reasonable, not scheduled.",
  },
  {
    id: "t-backlog-keyboard",
    content: "Audit every action for keyboard reachability",
    status: "backlog",
    area: AREA.product,
    offset: 6,
    order: 2,
    tags: ["task"],
    body: "[[Marcus Bell]] is right and it is an access question, not a preference.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Journals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Journals are written for days that had something worth recording. Padding
 * every weekday with filler would read as generated the moment anyone scrolls,
 * which is worse than an honest gap.
 */
const JOURNALS: Array<{ offset: number; body: string }> = [
  {
    offset: -55,
    body: [
      "Talked to [[Lena Fischer]] about whether to raise at all. She thinks yes, but",
      "only if the pitch leads with the file format instead of the feature list.",
      "",
      "Her framing is better than anything I had: we are not selling a note app,",
      "we are selling the claim that the files outlive the company. Sat with that",
      "for the rest of the afternoon.",
      "",
      "Starting the memo tomorrow.",
    ].join("\n"),
  },
  {
    offset: -54,
    body: [
      "Three hours on [[Seed investor memo]]. First draft done.",
      "",
      "The traction section wrote itself. The \"what is the second act\" section took",
      "two of the three hours and is still the weakest part, which is information.",
    ].join("\n"),
  },
  {
    offset: -52,
    body: [
      "[[Oskar Lindqvist]] found us through the file-over-app essay and offered a",
      "[[Priya Raman]] introduction before I could ask for one.",
      "",
      "Worth noting properly: every good thing that has happened in this raise so far",
      "started with writing, not outreach.",
    ].join("\n"),
  },
  {
    offset: -50,
    body: [
      "Cut the target list from eighteen firms to eleven. Dropped anyone who has",
      "publicly argued productivity tools are not venture-scale — no point spending",
      "a first meeting arguing someone's prior.",
      "",
      "Built the Investor Pipeline table rather than another spreadsheet. Using the",
      "product for the raise is a decent forcing function; the board view is",
      "genuinely not good enough yet.",
    ].join("\n"),
  },
  {
    offset: -47,
    body: [
      "[[Alex Rivera]] shipped the iCloud direct-write fallback.",
      "",
      "The bug [[Ravi Menon]] found could lose a file outright. He did not report it",
      "for two days because he assumed he had done something wrong — that detail has",
      "bothered me more than the bug. Data-loss failures need to be loud.",
      "",
      "[[RFC — iCloud direct-write fallback]] is written up. There is a follow-up we",
      "have not done.",
    ].join("\n"),
  },
  {
    offset: -44,
    body: [
      "First call with [[Priya Raman]]. Best investor conversation I have had.",
      "",
      "She had read the changelog. Asked about the FTS index in the first ten minutes.",
      "Then asked for retention cut by acquisition source and I did not have it,",
      "which was the one bad moment of an otherwise good call.",
      "",
      "Second call with the full partnership.",
    ].join("\n"),
  },
  {
    offset: -42,
    body: [
      "[[Tomas Bergström]]. Spent forty of forty-five minutes on collaboration and I",
      "spent all forty being defensive about it.",
      "",
      "It is the sharpest question about this business. Treating it as an attack",
      "rather than a question is how you lose a room.",
    ].join("\n"),
  },
  {
    offset: -40,
    body: [
      "[[Ana Ferreira]] committed $250k on a thirty-minute call. No second meeting,",
      "no information rights.",
      "",
      "First money in. The round is real now in a way it was not this morning.",
    ].join("\n"),
  },
  {
    offset: -38,
    body: [
      "[[Daniel Osei]] — ex-operator, shipped a sync engine, regretted it. His",
      "questions about conflict handling were more specific than anything I have been",
      "asked by an investor.",
      "",
      "Asked for a design partner reference and picked [[Ravi Menon]] himself off the",
      "deck. Slightly alarming, entirely fair.",
    ].join("\n"),
  },
  {
    offset: -35,
    body: [
      "[[Nadia Haddad]] in for $50k, then spent twenty minutes dismantling onboarding.",
      "",
      "Her point: the vault picker asks for a commitment before the user has any idea",
      "what a vault is. Obvious once said. That is the RFC.",
    ].join("\n"),
  },
  {
    offset: -31,
    body: [
      "[[Alex Rivera]] asked for the real runway number in our 1:1 and I did not have",
      "it to hand, which was embarrassing.",
      "",
      "Worked it out properly after: seven months without the round.",
      "[[Runway math, honestly]]. Told him the same day rather than sitting on it —",
      "a founding engineer who later discovers the number was worse than described",
      "never believes the next one.",
    ].join("\n"),
  },
  {
    offset: -30,
    body: [
      `${FIRMS.northwind} partnership meeting. Ran long, which I am told is the`,
      "signal you want.",
      "",
      "The retention reframe landed — presenting it as a product finding rather than",
      "a metric turned it from a soft number into something the room could argue",
      "with. Diligence next, then a decision meeting.",
    ].join("\n"),
  },
  {
    offset: -27,
    body: [
      "[[Jonas Klein]] security review. He wants an enumerable list of when data",
      "leaves the machine, not a marketing claim.",
      "",
      "Wrote [[When does data leave the machine?]] the same afternoon. Took two hours",
      "and unblocked sixty seats. We have been treating the security model as an",
      "implementation detail when it is a sales asset.",
    ].join("\n"),
  },
  {
    offset: -26,
    body: [
      "Index warmup shipped. [[Morgan Diaz]]'s fix — open the connection and run one",
      "throwaway query at launch, off the UI thread.",
      "",
      "First-query pause on a 900-file vault went from noticeable to gone.",
    ].join("\n"),
  },
  {
    offset: -21,
    body: [
      "[[Tomas Bergström]] passed. Fifteen minutes, on a call rather than by email,",
      "with a clean reason.",
      "",
      "Wrote [[Halyard passed — postmortem]] the same evening while it was still",
      "accurate rather than flattering. The useful part is not that he passed, it is",
      "that I answered his question badly and can fix that.",
    ].join("\n"),
  },
  {
    offset: -18,
    body: [
      "[[Mei Watanabe]] kicked off Foundry Line diligence. Cohort retention,",
      "conversion, two references.",
      "",
      "All reasonable and none of it assembled. Tomorrow is a data day.",
    ].join("\n"),
  },
  {
    offset: -17,
    body: [
      "Three hours assembling the diligence pack. Built the Metrics table properly",
      "instead of rebuilding a spreadsheet each time.",
      "",
      "Doing it forced the retention question open — the aggregate number was hiding",
      "the actual finding. [[Retention — what the number actually says]].",
    ].join("\n"),
  },
  {
    offset: -16,
    body: [
      `Retention is ${METRICS.weekFourRetention}% and I have been answering the`,
      "question differently in every meeting, which means I had not thought it",
      "through.",
      "",
      "The real finding: users who arrive with existing material stay, users who start",
      "from an empty vault leave. That is a product decision, not a metric.",
    ].join("\n"),
  },
  {
    offset: -13,
    body: [
      "[[Iris Chen]] interview. She watched three people quit in the forum in week",
      "one because they did not know what to put in an empty vault.",
      "",
      "Same finding as the retention data, from a completely different direction. That",
      "is about as much confirmation as you get.",
      "",
      "She has been doing community management for us, unpaid, for four months. That",
      "needs fixing and \"after the round\" is not a good enough answer.",
    ].join("\n"),
  },
  {
    offset: -12,
    body: [
      "Drafted [[RFC — onboarding starts with import]]. Invert the first screen —",
      "import a folder, connect a calendar, or start empty as the third option rather",
      "than the default.",
      "",
      "[[Alex Rivera]] thinks import-in-place means reading an arbitrary tree rather",
      "than migrating people into ours. He is probably right and it is a lot more",
      "work.",
    ].join("\n"),
  },
  {
    offset: -10,
    body: [
      "Design review on the Databases board view.",
      "",
      "Rejected cross-row formulas. [[Sam Chen]] settled it in one sentence: a formula",
      "cell is a value only the app can compute, which means the file stops being",
      "self-describing. That is the line.",
      "",
      "[[Hana Sato]] will not love it. Every request she makes is reasonable and the",
      "aggregate is Airtable.",
    ].join("\n"),
  },
  {
    offset: -9,
    body: [
      "Late session on [[YC W27 application — draft answers]].",
      "",
      "The \"why did you pick this idea\" answer is the only one that came out right",
      "first time, probably because it is the only one I have not rehearsed.",
      "",
      "\"Why now\" reads like the memo. Cut it.",
    ].join("\n"),
  },
  {
    offset: -7,
    body: [
      "SPC is a different audience from YC and the application should not be a copy.",
      "Wrote [[South Park Commons — what to lead with]].",
      "",
      "Lead with the constraint, not the traction. And say the unsolved part out",
      "loud — multi-device without a server, without CRDTs, without lying about",
      "conflicts. It is the most interesting thing about the problem.",
    ].join("\n"),
  },
  {
    offset: -5,
    body: [
      `Monthly update out. WAU ${METRICS.wauCurrent}, retention`,
      `${METRICS.weekFourRetention}%, MRR $${(METRICS.mrr / 1000).toFixed(1)}k.`,
      "",
      "Same three metrics as every month, including the month one of them was flat.",
      "[[Ana Ferreira]]'s rule and it is a good one.",
      "",
      "Also wrote [[Questions I still cannot answer well]] because I keep being",
      "surprised in meetings by questions I already know are coming.",
    ].join("\n"),
  },
  {
    offset: -4,
    body: [
      "[[Ravi Menon]] took the Foundry Line reference call.",
      "",
      "He apparently spent twenty minutes on the iCloud data-loss bug and how it was",
      "handled. Not the reference I would have chosen and probably a better one than",
      "anything I would have chosen.",
    ].join("\n"),
  },
  {
    offset: -3,
    body: [
      "[[Sofia Duarte]] gave the second reference, offered before I asked.",
      "",
      "Wrote [[Demo script — what to actually show]] in the afternoon. No slides. The",
      "moment that lands is following a wikilink to a person and showing their",
      "backlinks — Sofia described that unprompted as the reason she looks competent",
      "in 1:1s, and it is eight seconds of demo.",
    ].join("\n"),
  },
  {
    offset: -2,
    body: [
      "Week closed. Wrote [[Week in review]].",
      "",
      "Good week on references and shipping, bad week on the YC application, which",
      "is still not cut and is due Friday. Slept badly all week.",
    ].join("\n"),
  },
  {
    offset: 0,
    body: [
      "Demo day.",
      "",
      "Morning on the YC \"why now\" answer — 210 words down to something under 140.",
      "Every answer should be falsifiable; the second paragraph restates the memo and",
      "adds nothing, so it goes.",
      "",
      "Check in with [[Ravi Menon]] on whether the index warmup actually fixed the",
      "first-query pause at his vault size. Then Northwind prep — Thursday is the",
      "decision meeting and the collaboration answer is the one I still improvise.",
      "Rehearse it out loud once rather than trusting it to come out right.",
      "",
      "South Park Commons dinner tonight. Laptop, not slides. Lead with the",
      "constraint — see [[South Park Commons — what to lead with]].",
      "",
      "Still owe [[Priya Raman]] the retention cut by acquisition source. She asked",
      "on the first call. That is now genuinely overdue.",
    ].join("\n"),
  },
];

// ─────────────────────────────────────────────────────────────────────────────

export function buildCadence(
  w: VaultWriter,
  cal: Calendar,
  people: PersonRecord[],
): void {
  const known = new Set(people.map((person) => person.id));
  const checkAttendees = (id: string, attendees: readonly string[]): void => {
    for (const attendee of attendees) {
      if (!known.has(attendee)) {
        throw new Error(`event ${id} references unknown person "${attendee}"`);
      }
    }
  };

  // Weekly series, anchored to their first occurrence inside the history
  // window. Projection is forward-only, so anchoring early fills both the past
  // and the two scheduled weeks ahead.
  for (const series of SERIES) {
    checkAttendees(series.id, series.attendees);
    const anchor = firstWeekdayOnOrAfter(cal, -56, series.weekday);
    const event: EventInput = {
      id: series.id,
      title: series.title,
      date: cal.at(anchor, series.time),
      duration: series.duration,
      area: series.area,
      attendees: series.attendees,
      recurring: "weekly",
      tags: series.tags,
      body: series.body,
    };
    writeEvent(w, event);
  }

  for (const one of [...ONE_OFFS, ...demoDayEvents(cal)]) {
    checkAttendees(one.id, one.attendees ?? []);
    writeEvent(w, {
      id: one.id,
      title: one.title,
      date: cal.at(one.offset, one.time),
      duration: one.duration,
      area: one.area,
      attendees: one.attendees ?? [],
      recurring: "none",
      tags: one.tags,
      body: one.body,
    });
  }

  for (const task of TASKS) {
    const scheduled = cal.day(task.offset);
    const input: TaskInput = {
      id: task.id,
      content: task.content,
      status: task.status,
      area: task.area,
      created: cal.at(task.offset, "07:00"),
      scheduled,
      tags: task.tags ?? ["task"],
      timeSpentSeconds: task.timeSpentSeconds,
      // Spaced by 100 so a live drag-reorder has room to wedge a midpoint
      // between neighbours without renumbering.
      sortKey: task.order * 100,
      body: task.body,
    };
    if (task.running) {
      input.inProgressStartedAt = cal.at(task.offset, "08:30");
    }
    writeTask(w, input);
  }

  for (const journal of JOURNALS) {
    writeDaily(w, { date: cal.day(journal.offset), body: journal.body });
  }
}

/** First offset at or after `from` that falls on `weekday`. */
function firstWeekdayOnOrAfter(
  cal: Calendar,
  from: number,
  weekday: Weekday,
): number {
  for (let offset = from; offset < from + 7; offset += 1) {
    if (cal.weekday(offset) === weekday) return offset;
  }
  throw new Error(`no offset matching weekday ${weekday} near ${from}`);
}
