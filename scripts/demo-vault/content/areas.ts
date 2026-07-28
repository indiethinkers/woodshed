import type { Calendar } from "../dates";
import { writeArea, type VaultWriter } from "../emit";
import { AREA, RAISE } from "./narrative";

export interface AreaRecord {
  id: string;
  name: string;
}

/**
 * Area files must exist. `read_areas` (commands/areas.rs) falls back to five
 * hardcoded defaults when `areas/` is empty, which would contradict every
 * `area:` reference in the rest of the vault.
 */
// Colors are the dataviz reference palette's categorical slots, validated
// with scripts/validate_palette.js in light and dark. Area colours become
// chart segments on the Areas overview, so they have to survive CVD and
// contrast checks — the previous zinc/green pair sat at ΔE 10.9, below the
// normal-vision floor, i.e. hard to tell apart even with full colour vision.
export function buildAreas(w: VaultWriter, cal: Calendar): AreaRecord[] {
  const created = cal.atNaive(-63, "09:00");

  const areas = [
    {
      id: AREA.fundraise,
      name: "Fundraise",
      color: "#d95926",
      body: [
        `Raising a ${RAISE.target} seed on a ${RAISE.cap} cap ${RAISE.instrument}.`,
        "",
        "Everything about the round lives here: the memo, the target list, partner",
        "meeting notes, diligence requests, and the pipeline table.",
        "",
        "Rule for this area — every conversation gets written up the same day, even",
        "the bad ones. The passes are the most useful notes in the vault.",
      ].join("\n"),
    },
    {
      id: AREA.product,
      name: "Product",
      color: "#3987e5",
      body: [
        "Building the thing. RFCs, design reviews, bug threads, and the running",
        "argument about how far local-first can be pushed before sync stops being",
        "honest.",
        "",
        "Design partner feedback lands here first, then gets promoted to an RFC if",
        "it survives a week.",
      ].join("\n"),
    },
    {
      id: AREA.growth,
      name: "Growth",
      color: "#199e70",
      body: [
        "Distribution, positioning, and the writing that carries both.",
        "",
        "User interviews live here rather than in Product on purpose: they are as",
        "much about who is buying as about what to build.",
      ].join("\n"),
    },
    {
      id: AREA.personal,
      name: "Personal",
      color: "#c98500",
      body: [
        "Life outside the raise. Kept in the same vault deliberately — the whole",
        "premise is one graph, not a work tool and a separate personal tool.",
      ].join("\n"),
    },
  ];

  for (const area of areas) {
    writeArea(w, { ...area, created });
  }

  return areas.map(({ id, name }) => ({ id, name }));
}
