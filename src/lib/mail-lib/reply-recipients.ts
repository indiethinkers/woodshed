import type { EmailSummary } from "@/lib/mail-lib/types";

/** Resolve reply recipients without ever addressing the connected account. */
export function replyRecipients(
  source: EmailSummary,
  includeAll: boolean,
): { to: string[]; cc: string[] } {
  const ownAddress = source.inbox.startsWith("gmail:")
    ? source.inbox.slice("gmail:".length)
    : "";
  const excluded = new Set(
    [ownAddress]
      .map(normalizedAddress)
      .filter((address): address is string => address.length > 0),
  );
  const seen = new Set(excluded);
  const unique = (addresses: Array<string | undefined>): string[] => {
    const result: string[] = [];
    for (const address of addresses) {
      if (!address?.trim()) continue;
      const normalized = normalizedAddress(address);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(address.trim());
    }
    return result;
  };

  const senderIsSelf =
    normalizedAddress(source.fromEmail) === normalizedAddress(ownAddress);
  const toCandidates = includeAll
    ? [source.fromEmail, ...(source.to ?? [])]
    : senderIsSelf
      ? (source.to ?? [])
      : [source.fromEmail];

  return {
    to: unique(toCandidates),
    cc: includeAll ? unique(source.cc ?? []) : [],
  };
}

function normalizedAddress(address: string): string {
  const angleAddress = address.match(/<([^>]+)>/u)?.[1];
  return (angleAddress ?? address).trim().toLowerCase();
}
