import type { Calendar } from "../dates";
import {
  writeRow,
  writeTable,
  type ColumnInput,
  type VaultWriter,
  type ViewInput,
} from "../emit";
import { COMPANIES, FIRMS, METRICS, WAU_SERIES } from "./narrative";

function select(
  id: string,
  name: string,
  options: Array<[string, string, string]>,
): ColumnInput {
  return {
    id,
    name,
    type: "select",
    options: options.map(([optId, optName, color]) => ({
      id: optId,
      name: optName,
      color,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Investor Pipeline
// ─────────────────────────────────────────────────────────────────────────────

const PIPELINE_STAGES: Array<[string, string, string]> = [
  ["stage_target", "Target", "zinc"],
  ["stage_intro", "Intro made", "blue"],
  ["stage_first", "First call", "teal"],
  ["stage_dd", "Diligence", "amber"],
  ["stage_committed", "Committed", "green"],
  ["stage_passed", "Passed", "red"],
];

const PIPELINE_COLUMNS: ColumnInput[] = [
  { id: "col_firm", name: "Firm", type: "text", width: 220 },
  select("col_stage", "Stage", PIPELINE_STAGES),
  {
    id: "col_check",
    name: "Check size",
    type: "number",
    format: "us_dollar",
    precision: 0,
  },
  { id: "col_contact", name: "Contact", type: "text" },
  { id: "col_next", name: "Next step", type: "text", width: 260 },
  select("col_conviction", "Conviction", [
    ["conv_high", "High", "green"],
    ["conv_medium", "Medium", "amber"],
    ["conv_low", "Low", "zinc"],
  ]),
  { id: "col_last", name: "Last contact", type: "date" },
];

const PIPELINE_VIEWS: ViewInput[] = [
  {
    id: "view_pipeline_board",
    name: "By stage",
    type: "board",
    groupBy: "col_stage",
    calculations: { col_check: "sum" },
  },
  {
    id: "view_pipeline_all",
    name: "All firms",
    type: "table",
    sorts: [{ column: "col_last", direction: "desc" }],
    calculations: { col_check: "sum", col_firm: "count" },
  },
  {
    id: "view_pipeline_live",
    name: "Live conversations",
    type: "table",
    sorts: [{ column: "col_check", direction: "desc" }],
    filters: {
      op: "and",
      conditions: [
        { column: "col_stage", op: "is_not", value: "stage_passed" },
      ],
    },
    hidden: ["col_conviction"],
    calculations: { col_check: "sum" },
  },
];

interface PipelineRow {
  id: string;
  firm: string;
  stage: string;
  check: number;
  contact: string;
  next: string;
  conviction: string;
  lastOffset: number;
  body?: string;
}

const PIPELINE_ROWS: PipelineRow[] = [
  {
    id: "row_cedargrove",
    firm: FIRMS.cedargrove,
    stage: "stage_dd",
    check: 1_500_000,
    contact: "Amara Okafor",
    next: "Partner meeting: decision",
    conviction: "conv_high",
    lastOffset: -30,
    body: [
      "Lead candidate. Needs the retention cut by acquisition source, still not",
      "sent. See [[Retention: what the number actually says]].",
    ].join("\n"),
  },
  {
    id: "row_foundry",
    firm: FIRMS.foundryLine,
    stage: "stage_dd",
    check: 1_000_000,
    contact: "Daniel Osei",
    next: "Terms conversation",
    conviction: "conv_high",
    lastOffset: -18,
    body: "References done: [[Elliot Park]] and [[Sofia Duarte]] both landed well.",
  },
  {
    id: "row_ridgeline",
    firm: FIRMS.ridgeline,
    stage: "stage_committed",
    check: 250_000,
    contact: "Ana Ferreira",
    next: "Signed. Nothing outstanding.",
    conviction: "conv_high",
    lastOffset: -40,
    body: "First money in. Committed on a thirty-minute call with no second meeting.",
  },
  {
    id: "row_ben",
    firm: "Ben Whitfield (angel)",
    stage: "stage_committed",
    check: 100_000,
    contact: "Ben Whitfield",
    next: "Signed. Offered security-questionnaire help.",
    conviction: "conv_high",
    lastOffset: -38,
  },
  {
    id: "row_nadia",
    firm: "Nadia Haddad (angel)",
    stage: "stage_committed",
    check: 50_000,
    contact: "Nadia Haddad",
    next: "Signed. Reviewing onboarding designs.",
    conviction: "conv_high",
    lastOffset: -35,
  },
  {
    id: "row_halyard",
    firm: FIRMS.halyard,
    stage: "stage_passed",
    check: 0,
    contact: "Tomas Bergström",
    next: "Re-approach at Series A with a team plan",
    conviction: "conv_low",
    lastOffset: -21,
    body: "[[Halyard passed: postmortem]]. Clean reason, delivered on a call.",
  },
  {
    id: "row_brightwater",
    firm: "Brightwater",
    stage: "stage_first",
    check: 500_000,
    contact: "Maya Brooks",
    next: "Follow up after Cedar Grove decision",
    conviction: "conv_medium",
    lastOffset: -24,
    body: "Warm but slow. Deliberately not pushing until the lead is settled.",
  },
  {
    id: "row_kestrel",
    firm: "Kestrel Fund",
    stage: "stage_intro",
    check: 400_000,
    contact: "Owen Grant",
    next: "Intro made, no call booked",
    conviction: "conv_medium",
    lastOffset: -26,
  },
  {
    id: "row_lanternfield",
    firm: "Lanternfield Partners",
    stage: "stage_target",
    check: 0,
    contact: "Avery Morgan",
    next: "Only if the round needs filling",
    conviction: "conv_low",
    lastOffset: -50,
  },
  {
    id: "row_stonebridge",
    firm: "Stonebridge",
    stage: "stage_target",
    check: 0,
    contact: "Taylor Reed",
    next: "Not approached",
    conviction: "conv_low",
    lastOffset: -50,
  },
  {
    id: "row_marrow",
    firm: "Marrow Capital",
    stage: "stage_passed",
    check: 0,
    contact: "Devon Price",
    next: "Passed at intro: thesis mismatch",
    conviction: "conv_low",
    lastOffset: -45,
    body: "Passed before a call. Writes only infrastructure. Correctly filtered.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Design Partners
// ─────────────────────────────────────────────────────────────────────────────

const PARTNER_COLUMNS: ColumnInput[] = [
  { id: "col_company", name: "Company", type: "text", width: 200 },
  { id: "col_champion", name: "Champion", type: "text" },
  { id: "col_seats", name: "Seats", type: "number", precision: 0 },
  select("col_tier", "Tier", [
    ["tier_anchor", "Anchor", "purple"],
    ["tier_active", "Active", "teal"],
    ["tier_trial", "Trial", "zinc"],
  ]),
  { id: "col_activated", name: "Activated", type: "date" },
  { id: "col_paying", name: "Paying", type: "checkbox" },
  {
    id: "col_partner_tags",
    name: "Signals",
    type: "multi_select",
    options: [
      { id: "sig_reference", name: "Reference", color: "green" },
      { id: "sig_security", name: "Security review", color: "amber" },
      { id: "sig_large_vault", name: "Large vault", color: "blue" },
      { id: "sig_at_risk", name: "At risk", color: "red" },
    ],
  },
];

const PARTNER_VIEWS: ViewInput[] = [
  {
    id: "view_partners_all",
    name: "All partners",
    type: "table",
    sorts: [{ column: "col_seats", direction: "desc" }],
    calculations: { col_seats: "sum", col_company: "count" },
  },
  {
    id: "view_partners_tier",
    name: "By tier",
    type: "board",
    groupBy: "col_tier",
    calculations: { col_seats: "sum" },
  },
];

interface PartnerRow {
  id: string;
  company: string;
  champion: string;
  seats: number;
  tier: string;
  activatedOffset: number;
  paying: boolean;
  signals: string[];
  body?: string;
}

const PARTNER_ROWS: PartnerRow[] = [
  {
    id: "row_cartogram",
    company: COMPANIES.cartogram,
    champion: "Elliot Park",
    seats: 40,
    tier: "tier_anchor",
    activatedOffset: -60,
    paying: true,
    signals: ["sig_reference", "sig_large_vault"],
    body: [
      "First design partner and the source of the iCloud data-loss bug. Roughly 900",
      "files: every performance problem shows up here first.",
    ].join("\n"),
  },
  {
    id: "row_meridian",
    company: COMPANIES.meridian,
    champion: "Sofia Duarte",
    seats: 12,
    tier: "tier_anchor",
    activatedOffset: -50,
    paying: true,
    signals: ["sig_reference"],
    body: "Runs every 1:1 out of the vault. Source of the backlinks-as-CRM framing.",
  },
  {
    id: "row_ostrich",
    company: COMPANIES.ostrich,
    champion: "Jonas Klein",
    seats: 60,
    tier: "tier_active",
    activatedOffset: -42,
    paying: false,
    signals: ["sig_security"],
    body: [
      "Regulated market. Rollout was blocked on a written security answer until",
      "[[When does data leave the machine?]] existed.",
    ].join("\n"),
  },
  {
    id: "row_tinderbox",
    company: COMPANIES.tinderbox,
    champion: "Marcus Bell",
    seats: 1,
    tier: "tier_active",
    activatedOffset: -30,
    paying: true,
    signals: [],
    body: "Solo founder, textbook ICP, paid on day one. Loudest feedback loop we have.",
  },
  {
    id: "row_quarry",
    company: "Quarry Labs",
    champion: "Riley Moss",
    seats: 8,
    tier: "tier_active",
    activatedOffset: -33,
    paying: true,
    signals: [],
  },
  {
    id: "row_havershore",
    company: "Havershore",
    champion: "Cameron Ward",
    seats: 5,
    tier: "tier_trial",
    activatedOffset: -20,
    paying: false,
    signals: ["sig_at_risk"],
    body: "Two weeks with no activity. Started from an empty vault, which figures.",
  },
  {
    id: "row_pinegrove",
    company: "Pinegrove Studio",
    champion: "Noah Bennett",
    seats: 4,
    tier: "tier_trial",
    activatedOffset: -16,
    paying: false,
    signals: [],
  },
  {
    id: "row_ashfield",
    company: "Ashfield Research",
    champion: "Mina Patel",
    seats: 6,
    tier: "tier_active",
    activatedOffset: -28,
    paying: true,
    signals: ["sig_large_vault"],
  },
  {
    id: "row_wrenly",
    company: "Wrenly",
    champion: "Leo Martin",
    seats: 3,
    tier: "tier_trial",
    activatedOffset: -11,
    paying: false,
    signals: [],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

const METRIC_COLUMNS: ColumnInput[] = [
  { id: "col_week", name: "Week ending", type: "date", width: 140 },
  { id: "col_wau", name: "WAU", type: "number", precision: 0 },
  {
    id: "col_retention",
    name: "Week-4 retention",
    type: "number",
    format: "percent",
    precision: 0,
  },
  {
    id: "col_mrr",
    name: "MRR",
    type: "number",
    format: "us_dollar",
    precision: 0,
  },
  { id: "col_note", name: "Note", type: "text", width: 320 },
];

const METRIC_VIEWS: ViewInput[] = [
  {
    id: "view_metrics_all",
    name: "Weekly",
    type: "table",
    sorts: [{ column: "col_week", direction: "desc" }],
    calculations: { col_wau: "max", col_mrr: "max", col_retention: "avg" },
  },
];

/** One row per week, ending on demo day. Matches WAU_SERIES exactly. */
const METRIC_NOTES = [
  "Baseline week. Raise decision made.",
  "Local-first essay picked up in two newsletters.",
  "Cartogram expanded to 40 seats.",
  "iCloud data-loss bug found and fixed.",
  "Paid beta opened quietly: no announcement.",
  "Meridian rollout. First reference call.",
  "Index warmup shipped; first-query latency gone.",
  "Security document unblocked the Ostrich review.",
] as const;

// ─────────────────────────────────────────────────────────────────────────────

export function buildTables(w: VaultWriter, cal: Calendar): void {
  const created = cal.atNaive(-50, "16:30");

  writeTable(w, {
    id: "investor-pipeline",
    name: "Investor Pipeline",
    created,
    favorite: true,
    columns: PIPELINE_COLUMNS,
    views: PIPELINE_VIEWS,
  });
  for (const row of PIPELINE_ROWS) {
    writeRow(w, {
      id: row.id,
      table: "investor-pipeline",
      created,
      cells: {
        col_firm: row.firm,
        col_stage: row.stage,
        col_check: row.check,
        col_contact: row.contact,
        col_next: row.next,
        col_conviction: row.conviction,
        col_last: cal.day(row.lastOffset),
      },
      body: row.body,
    });
  }

  const partnersCreated = cal.atNaive(-58, "09:00");
  writeTable(w, {
    id: "design-partners",
    name: "Design Partners",
    created: partnersCreated,
    columns: PARTNER_COLUMNS,
    views: PARTNER_VIEWS,
  });
  for (const row of PARTNER_ROWS) {
    writeRow(w, {
      id: row.id,
      table: "design-partners",
      created: partnersCreated,
      cells: {
        col_company: row.company,
        col_champion: row.champion,
        col_seats: row.seats,
        col_tier: row.tier,
        col_activated: cal.day(row.activatedOffset),
        col_paying: row.paying,
        ...(row.signals.length > 0 ? { col_partner_tags: row.signals } : {}),
      },
      body: row.body,
    });
  }

  const metricsCreated = cal.atNaive(-17, "08:00");
  writeTable(w, {
    id: "metrics",
    name: "Metrics",
    created: metricsCreated,
    columns: METRIC_COLUMNS,
    views: METRIC_VIEWS,
  });
  WAU_SERIES.forEach((wau, index) => {
    // Oldest first: index 0 is seven weeks before demo day.
    const weekOffset = (index - (WAU_SERIES.length - 1)) * 7;
    const share = wau / METRICS.wauCurrent;
    writeRow(w, {
      id: `row_week_${index + 1}`,
      table: "metrics",
      created: metricsCreated,
      cells: {
        col_week: cal.day(weekOffset),
        col_wau: wau,
        // Retention climbs toward the current figure rather than being flat.
        col_retention: Math.round(
          METRICS.weekFourRetention * (0.72 + 0.28 * share),
        ),
        col_mrr: Math.round((METRICS.mrr * share) / 50) * 50,
        col_note: METRIC_NOTES[index],
      },
    });
  });
}
