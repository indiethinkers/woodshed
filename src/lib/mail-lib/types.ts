// Mail DTOs — mirror the Rust types in src-tauri/src/commands/mail.rs.
// Keep aligned by hand; Tauri 2 doesn't ship a type generator.

// ─── inboxes ────────────────────────────────────────────────────────────────

export interface Inbox {
  inboxId: string;
  email: string;
  displayName: string | null;
  /** RFC 3339. */
  createdAt: string;
}

// ─── messages ───────────────────────────────────────────────────────────────

export interface SyncStats {
  durationMs: number;
}

export interface EmailSummary {
  id: string;
  /** RFC 5322 Message-ID. Older records may omit it until their next sync. */
  messageId?: string;
  threadId: string;
  from: string;
  fromEmail: string;
  /** Persisted recipients; present on sent records and empty on legacy mail. */
  to?: string[];
  cc?: string[];
  subject: string;
  /** Full plaintext body (filled by sync's per-message expand or by mail_get_full). */
  body: string;
  /**
   * HTML version of the body, persisted in a sibling `.html` file in the
   * same folder as the markdown. Null when the message has no HTML
   * alternative (plaintext-only emails, things we sent).
   */
  html: string | null;
  /** First ~200 chars of body, derived locally. */
  preview: string;
  /** RFC 3339. */
  date: string;
  /** Gmail's authoritative \Seen state. */
  read: boolean;
  /** The message has been opened in Woodshed, even if Gmail sync failed. */
  viewed?: boolean;
  /** RFC 3339 deadline while an archived message is snoozed. */
  snoozedUntil?: string | null;
  labels: string[];
  /** Sender slug + locally-derived mentions. Drives wikilink resolution. */
  mentions: string[];
  links: string[];
  /** Inbox the message belongs to (`gmail:<email>`). */
  inbox: string;
  /**
   * Vault-relative path on disk (e.g. `inbox/foo-x7k3a9bz.md`). Empty
   * when the summary was constructed in-memory before a sync's first
   * write. Drives the file-path pill in the email detail header.
   */
  path: string;
  /**
   * Attachment metadata. Bytes live under
   * `attachments/mail/<message-id>/<filename>`, written eagerly during
   * Gmail sync.
   */
  attachments: Attachment[];
}

const PENDING_VIEWED_EMAIL_IDS = new Set<string>();

export function setEmailViewPending(id: string, pending: boolean): void {
  if (pending) PENDING_VIEWED_EMAIL_IDS.add(id);
  else PENDING_VIEWED_EMAIL_IDS.delete(id);
}

/** Whether Woodshed should still present this message as needing attention. */
export function shouldShowUnreadIndicator(
  email: Pick<EmailSummary, "id" | "read" | "viewed">,
): boolean {
  return (
    !email.read &&
    email.viewed !== true &&
    !PENDING_VIEWED_EMAIL_IDS.has(email.id)
  );
}

export interface MailPage {
  items: EmailSummary[];
  nextOffset: number | null;
}

export type MailFolder = "inbox" | "sent" | "archive";
export type Mailbox = MailFolder | "drafts";

export function isMailbox(value: unknown): value is Mailbox {
  return (
    value === "inbox" ||
    value === "drafts" ||
    value === "sent" ||
    value === "archive"
  );
}

/**
 * Metadata for a single attachment on an email. `id` is the MIME part
 * index ("0", "1", …). Callers pass it back through `mail_open_attachment`
 * without interpretation.
 */
export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/** Full message (summary + to/cc), read from the local disk record. */
export interface EmailFull extends EmailSummary {
  to: string[];
  cc: string[];
}

export interface MailSyncResult {
  emails: EmailSummary[];
  stats: SyncStats;
  /** Truly new inbound records created by this refresh. Re-fetches are zero. */
  newMessages?: number;
  /** Accounts that could not be refreshed while at least one other account
   * completed. Omitted when every requested account succeeded. */
  failedAccounts?: number;
  /** Local inbox messages archived during reconciliation because they
   * left the Gmail inbox (handled directly in Gmail). */
  removed?: number;
}

export interface MailSnoozeInput {
  id: string;
  /** RFC 3339. */
  snoozedUntil: string;
}

export interface MailSnoozeRestoreResult {
  restored: number;
  failed: number;
}

export interface ComposeInput {
  fromInbox?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: OutgoingAttachment[];
}

export interface ReplyInput {
  inReplyToMessageId: string;
  threadId: string;
  fromInbox?: string;
  to?: string[];
  cc?: string[];
  body: string;
  attachments?: OutgoingAttachment[];
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export interface SendResult {
  messageId: string;
  threadId: string;
  /** RFC 3339. */
  sentAt: string;
}

export type DraftKind = "new" | "reply";

export interface DraftDto {
  id: string;
  /** RFC 3339. */
  created: string;
  kind: DraftKind;
  fromInbox: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  sourceMessageId: string | null;
  threadId: string | null;
}

export interface DraftSaveInput {
  id?: string;
  kind: DraftKind;
  fromInbox?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  sourceMessageId?: string;
  threadId?: string;
}
