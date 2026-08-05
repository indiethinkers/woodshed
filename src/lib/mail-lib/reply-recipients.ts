import type { EmailSummary } from "@/lib/mail-lib/types";

/**
 * Resolve reply recipients without ever addressing the connected account.
 *
 * Received messages carry empty `to`/`cc` on the summary (only sent records
 * persist them); pass the lazily-loaded full message (`EmailFull`) so Reply
 * All addresses every participant of a received email, not just the sender.
 */
export function replyRecipients(
  source: Pick<EmailSummary, "inbox" | "fromEmail" | "to" | "cc">,
  includeAll: boolean,
  full?: Pick<EmailSummary, "to" | "cc"> | null,
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
  const toList = full?.to?.length ? full.to : (source.to ?? []);
  const ccList = full?.cc?.length ? full.cc : (source.cc ?? []);
  const toCandidates = includeAll
    ? [source.fromEmail, ...toList]
    : senderIsSelf
      ? toList
      : [source.fromEmail];

  return {
    to: unique(toCandidates),
    cc: includeAll ? unique(ccList) : [],
  };
}

function normalizedAddress(address: string): string {
  const angleAddress = address.match(/<([^>]+)>/u)?.[1];
  return (angleAddress ?? address).trim().toLowerCase();
}
