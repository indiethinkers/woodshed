import type { Calendar } from "../dates";
import { writePerson, type VaultWriter } from "../emit";
import { AREA, COMPANIES, FIRMS } from "./narrative";

export interface PersonRecord {
  id: string;
  name: string;
  email: string;
  company: string;
  role: string;
}

interface PersonSeed {
  id: string;
  name: string;
  role: string;
  company: string;
  email: string;
  area: string;
  /** Free text the user maintains by hand: the field that makes People a CRM. */
  relationship: string;
  favorite?: boolean;
  /** Days before demo day this person was added. */
  addedOffset: number;
  body: string;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

const PEOPLE: PersonSeed[] = [
  // ── Investors ──────────────────────────────────────────────────────────────
  {
    id: "amara-okafor",
    name: "Amara Okafor",
    role: "Partner",
    company: FIRMS.cedargrove,
    email: "amara@cedargrove.example",
    area: AREA.fundraise,
    relationship: "Lead candidate. Warm intro from Lena.",
    favorite: true,
    addedOffset: -52,
    body: [
      "Leads seed rounds in developer tools. Writes the memo herself, which is why",
      "her questions are sharper than everyone else's.",
      "",
      "Reads the changelog before the call. Asked about the FTS index design in the",
      "first ten minutes, unprompted.",
      "",
      "What she needs to get to conviction: retention past week 8, and evidence",
      "that the vault format is a moat rather than a preference.",
    ].join("\n"),
  },
  {
    id: "daniel-osei",
    name: "Daniel Osei",
    role: "Partner",
    company: FIRMS.foundryLine,
    email: "daniel@foundryline.example",
    area: AREA.fundraise,
    relationship: "Second-most engaged. Slower process, bigger check.",
    addedOffset: -48,
    body: [
      "Ex-operator. Ran infrastructure at a company that shipped a sync engine and",
      "regretted it, so he is unusually specific about what breaks.",
      "",
      "Wants a design partner reference call before moving. Suggested [[Elliot Park]]",
      "himself after seeing the Cartogram logo on the deck.",
    ].join("\n"),
  },
  {
    id: "mei-watanabe",
    name: "Mei Watanabe",
    role: "Principal",
    company: FIRMS.foundryLine,
    email: "mei@foundryline.example",
    area: AREA.fundraise,
    relationship: "Daniel's principal. Does the actual diligence work.",
    addedOffset: -46,
    body: [
      "Runs the diligence process at Foundry Line. Every data request comes through",
      "her, not Daniel.",
      "",
      "Fast, organized, and honest about where the process stands: worth keeping",
      "warm regardless of how this round lands.",
    ].join("\n"),
  },
  {
    id: "tomas-bergstrom",
    name: "Tomas Bergström",
    role: "Partner",
    company: FIRMS.halyard,
    email: "tomas@halyard.example",
    area: AREA.fundraise,
    relationship: "Passed. Worth re-approaching at Series A.",
    addedOffset: -44,
    body: [
      "Passed after the second call. The reason was clean and worth keeping:",
      "he does not believe single-player tools reach venture scale without a",
      "collaboration story, and did not want to underwrite one being added later.",
      "",
      "Disagreed but did not argue: the whole product thesis is that single-player",
      "is the point. Right call for both of us.",
      "",
      "Said to come back when there is a team plan with real usage behind it.",
    ].join("\n"),
  },
  {
    id: "ana-ferreira",
    name: "Ana Ferreira",
    role: "Seed Partner",
    company: FIRMS.ridgeline,
    email: "ana@ridgeline.example",
    area: AREA.fundraise,
    relationship: "Committed $250k. Fast, low-drama.",
    addedOffset: -40,
    body: [
      "Committed on the first call without a second meeting. Writes small checks",
      "quickly and does not ask for information rights.",
      "",
      "Useful as a forcing function: having a committed check made the Cedar Grove",
      "conversation noticeably more concrete.",
    ].join("\n"),
  },
  {
    id: "ben-whitfield",
    name: "Ben Whitfield",
    role: "Angel",
    company: "Independent",
    email: "ben@bwhitfield.example",
    area: AREA.fundraise,
    relationship: "Angel, $100k committed. Ex-payments infrastructure.",
    addedOffset: -38,
    body: [
      "Angel investor, formerly infrastructure at a payments company. Committed",
      "$100k after reading the memo, no call needed.",
      "",
      "Offered to help with the security questionnaire that enterprise design",
      "partners keep sending. Take him up on it.",
    ].join("\n"),
  },
  {
    id: "nadia-haddad",
    name: "Nadia Haddad",
    role: "Angel",
    company: "Independent",
    email: "nadia@haddad.example",
    area: AREA.fundraise,
    relationship: "Angel, $50k. Design-tool background, strong taste.",
    addedOffset: -35,
    body: [
      "Former design lead at a collaborative design tool. The most useful critic of",
      "the onboarding flow so far: pointed out that the vault picker asks for a",
      "commitment before the user has any idea what a vault is.",
      "",
      "That feedback became the onboarding RFC.",
    ].join("\n"),
  },
  {
    id: "oskar-lindqvist",
    name: "Oskar Lindqvist",
    role: "Scout",
    company: FIRMS.cedargrove,
    email: "oskar@cedargrove.example",
    area: AREA.fundraise,
    relationship: "Cedar Grove scout. Made the Amara intro.",
    addedOffset: -55,
    body: [
      "Scout for Cedar Grove. Found the project through the local-first essay and",
      "sent an unprompted intro to [[Amara Okafor]] the same week.",
      "",
      "Owed a real thank-you regardless of how the round ends.",
    ].join("\n"),
  },

  // ── Design partners and customers ─────────────────────────────────────────
  {
    id: "elliot-park",
    name: "Elliot Park",
    role: "Staff Engineer",
    company: COMPANIES.cartogram,
    email: "elliot@cartogram.example",
    area: AREA.product,
    relationship: "First design partner. Most demanding, most valuable.",
    favorite: true,
    addedOffset: -60,
    body: [
      "Design partner number one and the reason the iCloud write path exists.",
      "Found the rename-across-sync-boundary bug within a week of installing.",
      "",
      "Runs a 40-person platform team. Uses the vault for RFC drafts and incident",
      "notes, which is a heavier workload than the product was designed for: every",
      "performance problem shows up in his vault first.",
      "",
      "Agreed to be a reference for [[Daniel Osei]].",
    ].join("\n"),
  },
  {
    id: "sofia-duarte",
    name: "Sofia Duarte",
    role: "Engineering Manager",
    company: COMPANIES.meridian,
    email: "sofia@meridian.example",
    area: AREA.product,
    relationship: "Design partner. Best source of 1:1 and planning workflows.",
    addedOffset: -50,
    body: [
      "Manages twelve engineers and runs every 1:1 out of the vault. The People",
      "surface exists in roughly its current shape because of her feedback.",
      "",
      "Wants recurring-meeting notes to thread across occurrences. Reasonable ask,",
      "not scheduled yet.",
    ].join("\n"),
  },
  {
    id: "jonas-klein",
    name: "Jonas Klein",
    role: "CTO",
    company: COMPANIES.ostrich,
    email: "jonas@ostrich.example",
    area: AREA.product,
    relationship: "Design partner. Sent the security questionnaire.",
    addedOffset: -42,
    body: [
      "CTO at a 60-person company in a regulated market. Cares about exactly one",
      "thing: that no vault content leaves the machine unless the user invoked it.",
      "",
      "The bounded-network-actions design is the answer, and it holds up, but it",
      "needed to be written down properly before he would circulate it internally.",
    ].join("\n"),
  },
  {
    id: "hana-sato",
    name: "Hana Sato",
    role: "Principal PM",
    company: COMPANIES.cartogram,
    email: "hana@cartogram.example",
    area: AREA.product,
    relationship: "Elliot's PM counterpart. Pushes on the Databases surface.",
    addedOffset: -34,
    body: [
      "Uses tag tables the way most people use a spreadsheet. Filed the clearest",
      "request yet for grouped board views with per-column calculations.",
      "",
      "Good barometer for whether Databases is becoming a real database or staying",
      "a view over Markdown. It has to stay a view.",
    ].join("\n"),
  },
  {
    id: "marcus-bell",
    name: "Marcus Bell",
    role: "Founder",
    company: COMPANIES.tinderbox,
    email: "marcus@tinderbox.example",
    area: AREA.growth,
    relationship: "Early paid user. Loud advocate, useful critic.",
    addedOffset: -30,
    body: [
      "Solo founder who paid on day one and has not stopped sending feedback since.",
      "",
      "Represents the ICP almost too neatly: buys tools as infrastructure, reads",
      "changelogs, switches instantly when something is better and leaves just as",
      "fast when it is not.",
    ].join("\n"),
  },

  // ── Team ──────────────────────────────────────────────────────────────────
  {
    id: "jordan-lee",
    name: "Jordan Lee",
    role: "Founding Engineer",
    company: "Woodshed",
    email: "jordan@woodshed.example",
    area: AREA.product,
    relationship: "Founding engineer. Owns the Rust side end to end.",
    favorite: true,
    addedOffset: -62,
    body: [
      "Founding engineer. Owns the vault helpers, the watcher, and the search index.",
      "",
      "Wrote the atomic-write path and the iCloud direct-write fallback. If a record",
      "gets corrupted, Jordan finds out before the user does.",
      "",
      "Wants to know the runway number honestly rather than optimistically. Fair.",
    ].join("\n"),
  },
  {
    id: "sam-chen",
    name: "Sam Chen",
    role: "Engineering Lead",
    company: "Woodshed",
    email: "sam@woodshed.example",
    area: AREA.product,
    relationship: "Engineering lead. Runs the weekly design review.",
    addedOffset: -58,
    body: [
      "Runs design review and keeps the RFC process from becoming ceremony.",
      "",
      "Strong opinion, correct one: no feature ships until the failure mode is",
      "written down.",
    ].join("\n"),
  },
  {
    id: "morgan-diaz",
    name: "Morgan Diaz",
    role: "Data Engineer",
    company: "Woodshed",
    email: "morgan@woodshed.example",
    area: AREA.product,
    relationship: "Owns indexing, FTS, and the tag edge tables.",
    addedOffset: -45,
    body: [
      "Owns the SQLite index and the normalized tag/wikilink edges.",
      "",
      "Rebuilt tag queries to read from edge tables instead of rescanning every",
      "collection: the change that made large vaults usable.",
    ].join("\n"),
  },
  {
    id: "casey-kim",
    name: "Casey Kim",
    role: "Design",
    company: "Woodshed",
    email: "casey@woodshed.example",
    area: AREA.product,
    relationship: "Design. Part-time, three days a week.",
    addedOffset: -36,
    body: [
      "Part-time designer, three days a week, and the reason the app looks like a",
      "native tool rather than a web page in a window.",
      "",
      "Currently redrawing onboarding around Nadia's criticism.",
    ].join("\n"),
  },

  // ── Advisors and network ──────────────────────────────────────────────────
  {
    id: "lena-fischer",
    name: "Lena Fischer",
    role: "Advisor",
    company: "Independent",
    email: "lena@fischer.example",
    area: AREA.fundraise,
    relationship:
      "Advisor. Made the Cedar Grove intro. Talk to her before decisions.",
    favorite: true,
    addedOffset: -70,
    body: [
      "Built and sold a productivity tool. Has seen this exact raise from the other",
      "side and is blunt about what does not work.",
      "",
      'Her framing, worth keeping: "You are not selling a note app. You are selling',
      'the claim that the files outlive the company. Lead with that or do not raise."',
      "",
      "Made the [[Amara Okafor]] introduction.",
    ].join("\n"),
  },
  {
    id: "adeola-bakare",
    name: "Adeola Bakare",
    role: "Researcher",
    company: "Independent",
    email: "adeola@bakare.example",
    area: AREA.product,
    relationship: "Local-first researcher. Technical sounding board.",
    addedOffset: -56,
    body: [
      "Researches local-first and CRDT systems. The right person to check a sync",
      "claim against before it goes in a deck.",
      "",
      "Talked me out of promising conflict-free multi-device editing in the memo.",
      "The honest version, last-write-wins with visible revisions, is a weaker",
      "claim and a defensible one.",
    ].join("\n"),
  },
  {
    id: "grace-lin",
    name: "Grace Lin",
    role: "Talent Partner",
    company: "Independent",
    email: "grace@lintalent.example",
    area: AREA.growth,
    relationship: "Recruiter. Engaged only if the round closes.",
    addedOffset: -25,
    body: [
      "Contract technical recruiter. Has two Rust candidates queued for the moment",
      "there is budget to hire.",
      "",
      "Not engaged yet. Do not start a search that cannot be funded.",
    ].join("\n"),
  },
  {
    id: "theo-almeida",
    name: "Theo Almeida",
    role: "Writer",
    company: "Independent",
    email: "theo@almeida.example",
    area: AREA.growth,
    relationship: "Writes a devtools newsletter. Wants to cover the launch.",
    addedOffset: -28,
    body: [
      "Runs a devtools newsletter with a small but exactly-right readership.",
      "",
      "Offered to cover the public launch. Worth timing against the round closing",
      "rather than taking the coverage whenever it is offered.",
    ].join("\n"),
  },
  {
    id: "iris-chen",
    name: "Iris Chen",
    role: "Community",
    company: "Independent",
    email: "iris@irischen.example",
    area: AREA.growth,
    relationship: "Power user who answers more support questions than we do.",
    addedOffset: -22,
    body: [
      "Found the product through the file-over-app essay and has since written more",
      "helpful forum answers than the team has.",
      "",
      "Should be paid or formally thanked. Currently neither, which is not fine.",
    ].join("\n"),
  },

  // ── Personal ──────────────────────────────────────────────────────────────
  {
    id: "jamie-parker",
    name: "Jamie Parker",
    role: "Software Engineer",
    company: "Independent",
    email: "jamie@jparker.example",
    area: AREA.personal,
    relationship: "Closest friend. Weekly walk, no agenda.",
    addedOffset: -68,
    body: [
      "Standing Saturday walk. The one conversation each week that is not about the",
      "company, which is exactly why it is on the calendar.",
    ].join("\n"),
  },
  {
    id: "nora-whitcomb",
    name: "Nora Whitcomb",
    role: "Physiotherapist",
    company: "Independent",
    email: "nora@whitcomb.example",
    area: AREA.personal,
    relationship: "Climbing partner. Tuesday and Thursday evenings.",
    addedOffset: -65,
    body: [
      "Climbing partner. Tuesdays and Thursdays, which is the only reliable",
      "structure in the week during a raise.",
    ].join("\n"),
  },
];

export function buildPeople(w: VaultWriter, cal: Calendar): PersonRecord[] {
  for (const person of PEOPLE) {
    writePerson(w, {
      id: person.id,
      name: person.name,
      initials: initials(person.name),
      role: person.role,
      company: person.company,
      email: person.email,
      relationship: person.relationship,
      area: person.area,
      created: cal.atNaive(person.addedOffset, "10:15"),
      favorite: person.favorite,
      body: person.body,
    });
  }

  return PEOPLE.map(({ id, name, email, company, role }) => ({
    id,
    name,
    email,
    company,
    role,
  }));
}
