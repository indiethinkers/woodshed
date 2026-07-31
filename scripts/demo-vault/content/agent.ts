import type { Calendar } from "../dates";
import { writeAgentChat, type VaultWriter } from "../emit";
import { METRICS } from "./narrative";

interface ChatSeed {
  id: string;
  title: string;
  offset: number;
  pinned?: boolean;
  tags?: string[];
  context?: { title: string; route: string };
  turns: Array<{ role: "user" | "assistant"; time: string; content: string }>;
}

const CHATS: ChatSeed[] = [
  {
    id: "chat-hfc-application",
    title: "Draft the HFC application answer",
    offset: -7,
    pinned: true,
    tags: ["fundraise"],
    context: {
      title: "Harbor Founders Circle: what to lead with",
      route: "/notebook/hfc-application-notes",
    },
    turns: [
      {
        role: "user",
        time: "08:35",
        content: [
          "I'm applying to Harbor Founders Circle. I have my Launchpad draft open. Should I",
          "reuse those answers?",
        ].join("\n"),
      },
      {
        role: "assistant",
        time: "08:35",
        content: [
          "I'd argue no, and the reason is in your own notes.",
          "",
          "Your Launchpad draft leads with traction: WAU, retention, MRR, design partners.",
          "That's the right shape for an accelerator optimising for whether this gets",
          "big.",
          "",
          "But your note [[Harbor Founders Circle: what to lead with]] already makes the",
          "case that HFC is asking a different question. Is the problem genuinely",
          "unsolved, and are you the person who keeps pulling on it? That favours the",
          "technical argument.",
          "",
          "Concretely, I'd open with the constraint rather than the numbers:",
          "",
          "> The Markdown files are canonical. The index, caches, and link graph are",
          "> derived and disposable. Here's what that rules out, here's what",
          "> it buys, and here's the part I haven't solved.",
          "",
          "The unsolved part is your strongest material for this audience, not your",
          "weakest. Multi-device editing without a server, without CRDTs, and without",
          "misrepresenting conflict resolution is a real open problem, and you have a",
          "considered position on it from [[Adeola Bakare]].",
        ].join("\n"),
      },
      {
        role: "user",
        time: "08:41",
        content: "Isn't leading with an unsolved problem risky?",
      },
      {
        role: "assistant",
        time: "08:41",
        content: [
          "It would be with an investor who needs to underwrite an outcome. It's",
          "different here.",
          "",
          "Two things in your vault support the riskier version:",
          "",
          "1. [[Halyard passed: postmortem]]: you concluded the failure there wasn't",
          "   the collaboration question itself, it was answering it defensively. The",
          "   lesson generalises.",
          "2. [[What a partner actually reads in your memo]]: the highlight you saved",
          "   is Amara saying she goes looking for the paragraph where you admit what",
          "   isn't working, and stops reading if there isn't one.",
          "",
          "You've already decided candour reads as confidence to this kind of reader.",
          "This is the same bet in a lower-stakes venue.",
        ].join("\n"),
      },
    ],
  },
  {
    id: "chat-investor-week-summary",
    title: "Summarize this week's investor conversations",
    offset: -2,
    tags: ["fundraise"],
    turns: [
      {
        role: "user",
        time: "17:10",
        content:
          "Summarize where every investor conversation stands right now. Be blunt about what's stalled.",
      },
      {
        role: "assistant",
        time: "17:10",
        content: [
          "From the Investor Pipeline table and this week's mail:",
          "",
          "**Moving**",
          "",
          "- **Cedar Grove**: diligence, $1.5M. Partner meeting Thursday is the",
          "  decision. [[Amara Okafor]] has asked twice for the retention cut by",
          "  acquisition source and it still hasn't been sent.",
          "- **Foundry Line**: diligence, $1.0M. Both references landed;",
          "  [[Mei Watanabe]] confirmed Monday. [[Daniel Osei]] wants terms next week",
          "  and has asked a direct question you haven't answered: fill or co-lead.",
          "",
          "**Closed**",
          "",
          "- Ridgeline $250k, Ben Whitfield $100k, Nadia Haddad $50k. $400k committed",
          "  from angels and small checks.",
          "",
          "**Stalled**",
          "",
          "- **Brightwater**: first call 24 days ago, no follow-up since. Your note",
          "  says this is deliberate until the lead is settled, so it's stalled on",
          "  purpose.",
          "- **Kestrel Fund**: intro made 26 days ago, no call ever booked. This one",
          "  looks stalled by omission rather than by choice.",
          "",
          "**Dead**",
          "",
          "- Halyard passed. Marrow passed at intro.",
          "",
          "The two things blocking progress are both replies you owe: the retention cut",
          "to Amara, and the fill-or-co-lead answer to Daniel.",
        ].join("\n"),
      },
      {
        role: "user",
        time: "17:18",
        content: "How much is actually committed vs in play?",
      },
      {
        role: "assistant",
        time: "17:18",
        content: [
          "**Committed:** $400k: Ridgeline, Whitfield, Haddad.",
          "",
          "**In diligence:** $2.5M across Cedar Grove and Foundry Line. Both are",
          "realistically decision-stage rather than speculative.",
          "",
          "**Speculative:** $900k across Brightwater and Kestrel.",
          "",
          "Worth noting the arithmetic: Cedar Grove and Foundry Line together are $2.5M,",
          "which is your entire target, and you already have $400k committed on top.",
          "If both land you're oversubscribed and will have to cut someone back.",
          "",
          "That's the scenario behind Daniel's fill-or-co-lead question, and it's",
          "probably why he asked it directly.",
        ].join("\n"),
      },
    ],
  },
  {
    id: "chat-design-partner-sync",
    title: "What did design partners say about sync?",
    offset: -20,
    tags: ["rfc", "local-first"],
    turns: [
      {
        role: "user",
        time: "20:05",
        content:
          "Pull together everything design partners have said about sync and multi-device. I'm writing the shared-vaults RFC.",
      },
      {
        role: "assistant",
        time: "20:05",
        content: [
          "Four sources in the vault, and they don't fully agree.",
          "",
          "**[[Elliot Park]]** (Cartogram): runs a laptop and a desktop through iCloud.",
          "This is where the rename data-loss bug came from. His framing is that sync",
          "is already happening whether you support it or not, so the question is",
          "whether you handle it honestly.",
          "",
          "**[[Sofia Duarte]]** (Meridian): hasn't raised sync at all. Her asks are",
          "about recurring-meeting notes threading. Single machine, no pressure here.",
          "",
          "**[[Jonas Klein]]** (Ostrich): cares about sync only as a security surface.",
          "His question is what happens on a network share, not whether two people can",
          "edit at once.",
          "",
          "**[[Iris Chen]]** (community): reports sync between machines is asked about",
          "*constantly* in the forum. She's been telling people it works through",
          "whatever folder sync they already use and conflicts are their problem.",
          "",
          "The split is worth noting: your enterprise partners want sync to be *safe*,",
          "your individual users want it to *exist*. Those pull toward different",
          "designs.",
        ].join("\n"),
      },
      {
        role: "user",
        time: "20:14",
        content:
          "Iris has been telling people conflicts are their problem. Is that answer wrong?",
      },
      {
        role: "assistant",
        time: "20:14",
        content: [
          "It's accurate today, and it's the answer your own design direction says you",
          "should keep giving, with one addition.",
          "",
          "[[CRDTs solve the wrong half of the problem]], which [[Adeola Bakare]] wrote",
          "and you saved, argues automatic merges of prose produce documents that",
          "converge without meaning anything. Your position in",
          "[[RFC: shared vaults (sketch)]] follows from that: last-write-wins with",
          "every superseded version kept as a visible revision.",
          "",
          "So Iris is right that conflicts are the user's problem. What's missing is",
          "that you intend to make them *visible and recoverable* rather than silent.",
          'The current honest answer is "conflicts are yours to resolve, and right now',
          "we don't help you see them\": the second clause is the part that's",
          "uncomfortable and true.",
          "",
          "It might be worth giving her that phrasing directly. She's answering more",
          "support questions than the team is.",
        ].join("\n"),
      },
    ],
  },
  {
    id: "chat-metrics-to-table",
    title: "Turn my metrics note into a table",
    offset: -17,
    tags: ["dd"],
    context: {
      title: "Metrics",
      route: "/databases",
    },
    turns: [
      {
        role: "user",
        time: "09:20",
        content: [
          "I've been rebuilding a spreadsheet every time an investor asks for numbers.",
          "Mei needs cohort retention, conversion and MRR. What should the table look",
          "like?",
        ].join("\n"),
      },
      {
        role: "assistant",
        time: "09:20",
        content: [
          "One row per week, five columns:",
          "",
          "- **Week ending** (date)",
          "- **WAU** (number)",
          "- **Week-4 retention** (percent)",
          "- **MRR** (currency)",
          "- **Note** (text): what happened that week",
          "",
          "The Note column is the one that makes this worth keeping rather than",
          "regenerating. A number with no cause attached is what forces you to rebuild",
          `the spreadsheet each time. \"${METRICS.wauCurrent} WAU\" is a fact;`,
          '"WAU jumped because the local-first essay was picked up in two newsletters"',
          "is an answer to the question they're actually asking.",
          "",
          "Since it's Markdown, each row can also carry a body, so a week with an",
          "anomaly gets a paragraph rather than a cramped cell.",
        ].join("\n"),
      },
      {
        role: "user",
        time: "09:31",
        content:
          "Should I split retention by acquisition source in the same table?",
      },
      {
        role: "assistant",
        time: "09:31",
        content: [
          "I'd keep it separate, for a reason your own analysis supports.",
          "",
          "[[Retention: what the number actually says]] concludes the interesting cut",
          "isn't weekly: it's whether a user arrived with existing material. That's a",
          "property of the cohort, not of the week, and forcing it into a weekly table",
          "would flatten the finding back into the aggregate you're trying to get away",
          "from.",
          "",
          'A weekly table answers "is this growing". A cohort table answers "who stays',
          "and why\". Mei asked for both, but they're different documents and the",
          "second one is the one that changes anyone's mind.",
        ].join("\n"),
      },
    ],
  },
];

export function buildAgent(w: VaultWriter, cal: Calendar): void {
  for (const chat of CHATS) {
    const messages = chat.turns.map((turn, index) => ({
      id: `msg-${chat.id}-${index + 1}`,
      role: turn.role,
      created: cal.at(chat.offset, turn.time),
      content: turn.content,
    }));
    const last = chat.turns[chat.turns.length - 1];

    writeAgentChat(w, {
      id: chat.id,
      title: chat.title,
      agent: "hermes",
      model: "claude-opus-5",
      created: cal.at(chat.offset, chat.turns[0].time),
      updated: cal.at(chat.offset, last.time),
      pinned: chat.pinned,
      tags: chat.tags,
      context: chat.context,
      messages,
    });
  }
}
