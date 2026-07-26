// Inbox Sweep DTOs — mirror the Rust types in src-tauri/src/sweep/mod.rs.
// Kept aligned by hand; Tauri 2 ships no type generator.

export type SweepStatus = "to_review" | "queued" | "working" | "done";

export type SweepActionKind =
  | "reply"
  | "forward"
  | "archive"
  | "task"
  | "person"
  | "snooze"
  | "none";

/** One entry in a card's append-only audit trail. */
export interface SweepEvent {
  /** RFC 3339. */
  at: string;
  /** "hermes" | "you" | "app". */
  actor: string;
  action: string;
  detail?: string | null;
}

export interface SweepCard {
  id: string;
  /** Vault-relative path (e.g. `sweep/sweep-xxxx.md`). */
  path: string;
  emailId: string;
  threadId?: string | null;
  inbox?: string | null;
  from: string;
  subject: string;
  emailDate?: string | null;
  status: SweepStatus;
  /** AI subject-style headline (the serif title on the card). */
  headline: string;
  summary: string;
  whatHappened: string;
  actionKind: SweepActionKind;
  /** e.g. "Draft reply", "Draft forward". */
  actionLabel: string;
  actionTarget?: string | null;
  draft: string;
  /** Linked drafts/<id> once a real mail draft is persisted (unused in v1). */
  draftId?: string | null;
  why: string[];
  snoozeUntil?: string | null;
  created: string;
  updated: string;
  timeline: SweepEvent[];
}

export type SweepPlannedActionKind =
  | "create_resource"
  | "create_task"
  | "archive_email";

export interface SweepPlannedAction {
  kind: SweepPlannedActionKind | string;
  url?: string | null;
  title?: string | null;
  content?: string | null;
  scheduled?: string | null;
  tags?: string[];
  reason?: string | null;
}

export interface SweepCommandPlan {
  actions: SweepPlannedAction[];
  note?: string | null;
}
