import { AvatarColor } from "@/lib/types";

type AvatarColorPair = { bg: string; text: string };

const avatarColorMap: Record<AvatarColor, AvatarColorPair> = {
  teal: { bg: "#E1F5EE", text: "#085041" },
  purple: { bg: "#EEEDFE", text: "#3C3489" },
  blue: { bg: "#E6F1FB", text: "#0C447C" },
  coral: { bg: "#FAECE7", text: "#712B13" },
  pink: { bg: "#FBEAF0", text: "#72243E" },
  amber: { bg: "#FAEEDA", text: "#633806" },
  gray: { bg: "#F1EFE8", text: "#444441" },
};

/** Deterministic order — the palette a hashed identity can land on. */
const AVATAR_COLORS: AvatarColor[] = [
  "teal",
  "purple",
  "blue",
  "coral",
  "pink",
  "amber",
  "gray",
];

export function getAvatarColor(color: AvatarColor): AvatarColorPair {
  return avatarColorMap[color] ?? avatarColorMap.gray;
}

/**
 * Deterministic avatar tint for an identity (Gmail-style: the same
 * sender always gets the same color). Keyed by email when available so
 * display-name churn ("Jordan H." → "Jordan") doesn't recolor a person.
 */
export function avatarColorForEmail(email: string): AvatarColor {
  const normalized = email.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Initials from the local-part of an email ("jordan.hoffman" → "J",
 * "no-reply" → "N"). Gmail uses a single letter for email-only senders —
 * two letters would read like a person's initials ("NR" for no-reply). */
export function initialsFromEmailLocalPart(email: string): string {
  const local = email.split("@")[0] ?? "";
  const first = local.split(/[^A-Za-z0-9]+/).find(Boolean);
  return first ? first[0]!.toUpperCase() : "?";
}

/**
 * Up to two initials from a display name, falling back to the email
 * local-part when the name is missing or has no word characters.
 */
export function initialsForName(
  name: string | null | undefined,
  email: string,
): string {
  const words = (name ?? "")
    .split(/\s+/)
    .filter((word) => /[A-Za-z0-9]/.test(word));
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join("");
  }
  return initialsFromEmailLocalPart(email);
}

interface ParsedAddress {
  /** Display name, or null when the address is a bare email / bare name. */
  name: string | null;
  email: string;
}

/**
 * Split an RFC 5322-ish address ("Display Name <email@host>") or a bare
 * email / bare name into its parts. Bare emails win when both are present
 * and the name is empty.
 */
export function parseMailAddress(value: string): ParsedAddress {
  const angle = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1].replace(/^"+|"+$/g, "").trim();
    return { name: name || null, email: angle[2].trim() };
  }
  const trimmed = value.trim();
  if (/^[^@\s]+@[^@\s]+$/.test(trimmed)) {
    return { name: null, email: trimmed };
  }
  return { name: trimmed || null, email: "" };
}

/** Gmail-style avatar identity for an address line: initials + tint. */
export function addressAvatar(
  value: string,
  emailOverride?: string,
): { initials: string; color: AvatarColor } {
  const parsed = parseMailAddress(value);
  const email = (emailOverride ?? parsed.email).trim();
  const colorKey = email || parsed.name || value;
  return {
    initials: initialsForName(parsed.name, email),
    color: avatarColorForEmail(colorKey),
  };
}
