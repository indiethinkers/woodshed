import type { EmailSummary } from "@/lib/mail-lib/types";
import type { PersonDto } from "@/lib/hooks/use-people";

export function findPersonForMailSender(
  people: PersonDto[],
  email: Pick<EmailSummary, "fromEmail" | "mentions">,
): PersonDto | undefined {
  const mentionIds = email.mentions.map(normalize).filter(Boolean);
  for (const id of mentionIds) {
    const match = people.find(
      (person) => normalize(person.id) === id || normalize(person.name) === id,
    );
    if (match) return match;
  }

  const senderEmail = normalizeEmail(email.fromEmail);
  if (!senderEmail) return undefined;
  return people.find((person) => normalizeEmail(person.email) === senderEmail);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
