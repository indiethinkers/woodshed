// The storyline every surface draws from.
//
// Numbers live here and nowhere else. If the metrics table says 1,240 WAU, the
// investor update email has to say 1,240 too — an audience that spots a
// contradiction stops looking at the product and starts auditing the data.
//
// Everyone and every company named here is invented. Addresses use `.example`,
// a reserved TLD that can never resolve, so nothing in this dataset can be
// mistaken for or delivered to a real party.
//
// One deliberate exception: the founder's *own* notes, tasks and calendar
// entries mention real accelerators (Y Combinator, South Park Commons) because
// applying to them is the actual scenario being demoed. No mail is ever
// attributed to a real organization or person — fabricating correspondence
// from a real party is a different thing entirely, and this dataset does not
// contain any.

export const AREA = {
  fundraise: "fundraise",
  product: "product",
  growth: "growth",
  personal: "personal",
} as const;

/** The founder's own mailbox. Mail records key off this. */
export const FOUNDER = {
  name: "Dana Whitfield",
  email: "dana@woodshed.example",
  inbox: "gmail:dana@woodshed.example",
} as const;

/** Headline metrics, quoted verbatim across mail, notes and the metrics table. */
export const METRICS = {
  wauCurrent: 1240,
  wauEightWeeksAgo: 610,
  designPartners: 9,
  weekFourRetention: 38,
  mrr: 2400,
  vaultsCreated: 3180,
} as const;

/** Raise parameters, quoted in the memo, the pipeline table and investor mail. */
export const RAISE = {
  target: "$2.5M",
  instrument: "post-money SAFE",
  cap: "$14M",
  committed: "$1.35M",
} as const;

/** Weekly WAU series, oldest first — eight weeks ending on demo day. */
export const WAU_SERIES = [610, 685, 740, 815, 905, 1010, 1130, 1240] as const;

export const FIRMS = {
  northwind: "Northwind Capital",
  foundryLine: "Foundry Line",
  halyard: "Halyard Ventures",
  ridgeline: "Ridgeline Partners",
} as const;

export const COMPANIES = {
  cartogram: "Cartogram",
  meridian: "Meridian Labs",
  ostrich: "Ostrich Systems",
  tinderbox: "Tinderbox Analytics",
} as const;

/** Tag vocabulary, applied consistently so tag tables return real result sets. */
export const TAGS = {
  fundraise: "fundraise",
  dd: "dd",
  userInterview: "user-interview",
  rfc: "rfc",
  localFirst: "local-first",
  positioning: "positioning",
  essay: "essay",
  hiring: "hiring",
} as const;
