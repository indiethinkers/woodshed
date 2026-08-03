// Mail commands. Each call invokes a Tauri command. Gmail (IMAP/SMTP via
// App Passwords) is the courier; results persist as markdown in
// `~/woodshed/inbox|sent|archive|drafts/`.
//
// Pull cadence: foreground polling defaults to five minutes and can be changed
// or disabled in Settings. The scheduler catches up when the app regains focus.

import { tauriInvoke } from "@/lib/tauri";
import type {
  ComposeInput,
  DraftDto,
  DraftSaveInput,
  EmailFull,
  EmailSummary,
  Inbox,
  MailSyncResult,
  MailPage,
  MailFolder,
  MailSnoozeInput,
  MailSnoozeRestoreResult,
  ReplyInput,
  SendResult,
} from "./types";

/**
 * List every "inbox" the user has configured: the Gmail accounts
 * (IMAP+App Password) they've connected, each as an `Inbox` so the
 * dropdown renders them uniformly.
 */
export async function inboxesList(): Promise<Inbox[]> {
  return (await tauriInvoke<Inbox[]>("gmail_inboxes_list").catch(() => null)) ?? [];
}

/**
 * Full message (summary + to/cc) for a single message. Gmail sync stores
 * the full body locally, so this reads from disk; use mailGetLocal for the
 * summary-only path.
 */
export async function mailGetFull(id: string): Promise<EmailFull | null> {
  return tauriInvoke<EmailFull>("mail_get_full", { id });
}

/** Read one bounded page of frontmatter-only inbox summaries. */
export async function mailInboxPage(
  offset = 0,
  limit = 200,
): Promise<MailPage> {
  return (
    (await tauriInvoke<MailPage>("mail_inbox_page", { offset, limit })) ?? {
      items: [],
      nextOffset: null,
    }
  );
}

/** Read one indexed page from a durable mail folder, optionally through FTS. */
export async function mailFolderPage(
  folder: MailFolder,
  query = "",
  offset = 0,
  limit = 200,
): Promise<MailPage> {
  return (
    (await tauriInvoke<MailPage>("mail_folder_page", {
      folder,
      query: query.trim() || null,
      offset,
      limit,
    })) ?? { items: [], nextOffset: null }
  );
}

/**
 * Resolve an attachment to a path on disk (written eagerly during Gmail
 * sync) and open it with the OS default app.
 */
export async function mailOpenAttachment(
  messageId: string,
  attachmentId: string,
): Promise<void> {
  await tauriInvoke<void>("mail_open_attachment", {
    messageId,
    attachmentId,
  });
}

/**
 * Return every locally-persisted message with the given thread id, sorted
 * oldest-first. Walks inbox/, sent/, and archive/ so a conversation
 * spanning folders renders as a single thread in the detail view.
 */
export async function mailThread(threadId: string): Promise<EmailSummary[]> {
  return (
    (await tauriInvoke<EmailSummary[]>("mail_thread", { threadId })) ?? []
  );
}

/** Mark a single message as read upstream + rewrite the local file. */
export async function mailMarkRead(id: string): Promise<void> {
  await tauriInvoke<void>("mail_mark_read", { id });
}

/**
 * Archive a single message: Gmail removes the IMAP INBOX label (which also
 * marks it read), then the local file moves from `inbox/` to `archive/`.
 */
export async function mailArchiveOne(id: string): Promise<void> {
  await tauriInvoke<void>("mail_archive_one", { id });
}

/** Archive + mark read now, then return the message to INBOX at the deadline. */
export async function mailSnooze(input: MailSnoozeInput): Promise<void> {
  await tauriInvoke<void>("mail_snooze", { input });
}

/** Restore every locally-due snooze, updating Gmail before local INBOX state. */
export async function mailRestoreDueSnoozes(): Promise<MailSnoozeRestoreResult> {
  return (
    (await tauriInvoke<MailSnoozeRestoreResult>(
      "mail_restore_due_snoozes",
    )) ?? { restored: 0, failed: 0 }
  );
}

/**
 * Delete a message's local file. Doesn't touch the Gmail mailbox — this
 * only hides the message from this app's view.
 */
export async function mailDeleteOne(id: string): Promise<void> {
  await tauriInvoke<void>("mail_delete_one", { id });
}

/**
 * Read a single email by id from disk (inbox/, sent/, or archive/).
 * Returns null if no matching markdown file exists. Free + offline.
 */
export async function mailGetLocal(id: string): Promise<EmailSummary | null> {
  return tauriInvoke<EmailSummary | null>("mail_get_local", { id });
}

interface GmailAccountInfo {
  email: string;
  inbox: string;
  displayName: string;
}

interface GmailSyncResult {
  written: string[];
  newMessages: number;
  fetched: number;
  removed: number;
  durationMs: number;
  email: string;
}

/** List every configured Gmail account (env-vars + config-store merged). */
export async function gmailAccountsList(): Promise<GmailAccountInfo[]> {
  return (await tauriInvoke<GmailAccountInfo[]>("gmail_accounts_list")) ?? [];
}

/** Sync one Gmail account, return a MailSyncResult-shaped value. */
async function gmailSyncOne(
  accountEmail: string,
  limit: number,
): Promise<MailSyncResult> {
  const result = await tauriInvoke<GmailSyncResult>("gmail_sync_recent", {
    accountEmail,
    limit,
  });
  if (!result) return { emails: [], stats: { durationMs: 0 } };
  // Synthesize EmailSummary stubs sized to `written` so the toolbar
  // count ("12 emails · 1.4s") matches reality. The actual messages
  // are already on disk; the inbox list re-reads them after invalidation.
  const stubs: EmailSummary[] = result.written.map((id) => ({
    id,
    threadId: id,
    from: "",
    fromEmail: "",
    subject: "",
    body: "",
    html: null,
    preview: "",
    date: "",
    read: false,
    labels: [],
    mentions: [],
    links: [],
    inbox: `gmail:${result.email}`,
    path: "",
    attachments: [],
  }));
  return {
    emails: stubs,
    stats: { durationMs: result.durationMs },
    newMessages: result.newMessages ?? 0,
    removed: result.removed ?? 0,
  };
}

/**
 * Sync every configured Gmail account in parallel, returning the merged
 * result. Used when the inbox filter is "All" — we fan out across every
 * Gmail account the user has, not just one. `Promise.allSettled` so a
 * single account's auth failure doesn't hide the others' fresh mail.
 */
async function gmailSyncAll(limit: number): Promise<MailSyncResult> {
  const accounts = await gmailAccountsList();
  if (accounts.length === 0) {
    return { emails: [], stats: { durationMs: 0 } };
  }
  const results = await Promise.allSettled(
    accounts.map((a) => gmailSyncOne(a.email, limit)),
  );
  const merged: MailSyncResult = {
    emails: [],
    stats: { durationMs: 0 },
    newMessages: 0,
    removed: 0,
  };
  let lastError: unknown = null;
  let succeededAccounts = 0;
  let failedAccounts = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      succeededAccounts += 1;
      merged.emails.push(...r.value.emails);
      merged.newMessages =
        (merged.newMessages ?? 0) + (r.value.newMessages ?? 0);
      merged.removed = (merged.removed ?? 0) + (r.value.removed ?? 0);
      merged.stats.durationMs = Math.max(
        merged.stats.durationMs,
        r.value.stats.durationMs,
      );
    } else {
      failedAccounts += 1;
      lastError = r.reason;
    }
  }
  if (succeededAccounts === 0 && lastError !== null) {
    throw lastError;
  }
  if (failedAccounts > 0) merged.failedAccounts = failedAccounts;
  return merged;
}

/**
 * Sync recent messages. With no inbox scope, fan out across every Gmail
 * account; with a `gmail:<email>` scope, sync just that one. Returns the
 * emails plus wall-clock duration for the toolbar.
 */
export async function mailSyncRecentMulti(
  limit = 20,
  inboxId?: string,
): Promise<MailSyncResult> {
  if (inboxId === undefined) {
    return gmailSyncAll(limit);
  }
  if (inboxId.startsWith("gmail:")) {
    return gmailSyncOne(inboxId.slice("gmail:".length), limit);
  }
  return { emails: [], stats: { durationMs: 0 } };
}

export async function mailSend(input: ComposeInput): Promise<SendResult | null> {
  return tauriInvoke<SendResult>("gmail_send", { input });
}

export async function mailReply(input: ReplyInput): Promise<SendResult | null> {
  // The backend resolves the sending account from the original message's
  // inbox, so no provider routing is needed here.
  return tauriInvoke<SendResult>("gmail_reply", { input });
}

export async function mailDraftSave(input: DraftSaveInput): Promise<DraftDto | null> {
  return tauriInvoke<DraftDto>("mail_draft_save", { input });
}

export async function mailDraftsList(query = ""): Promise<DraftDto[]> {
  return (
    (await tauriInvoke<DraftDto[]>("mail_drafts_list", {
      query: query.trim() || null,
    })) ?? []
  );
}

export async function mailDraftDelete(id: string): Promise<void> {
  await tauriInvoke<void>("mail_draft_delete", { id });
}
