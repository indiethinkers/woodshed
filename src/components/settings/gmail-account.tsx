import { useEffect, useRef, useState } from "react";
import { ExternalLink, Plus, X } from "lucide-react";
import { SettingsGroup } from "@/components/settings/settings-page";
import { tauriInvoke } from "@/lib/tauri";

/**
 * Gmail accounts panel — multi-account. Lists every configured Gmail
 * account (Tauri-store metadata merged with the env-vars account in
 * dev), with per-row rename/sync/disconnect plus an "Add account" form.
 */
interface AccountInfo {
  email: string;
  inbox: string;
  /** Label shown in the inbox dropdown / settings list. */
  displayName: string;
  /** "From:" name on outgoing mail. Empty string means "send as bare email." */
  senderName: string;
}

interface SyncResult {
  written: string[];
  fetched: number;
  durationMs: number;
  email: string;
}

export function GmailAccountSection() {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    try {
      const list = await tauriInvoke<AccountInfo[]>("gmail_accounts_list");
      setAccounts(list ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAccounts([]);
    }
  }

  return (
    <SettingsGroup
      label="Gmail accounts"
      description="Connect Gmail accounts via IMAP + App Password. Passwords stay in macOS Keychain; signed releases remember access, while unsigned development rebuilds may prompt again."
    >
      <div className="flex flex-col gap-3 max-w-[640px]">
        {accounts === null ? (
          <p className="font-mono text-[12px] text-muted-foreground">Loading…</p>
        ) : (
          <>
            {accounts.length === 0 && !adding && (
              <p className="text-[12px] text-muted-foreground">
                No Gmail accounts yet.
              </p>
            )}
            {accounts.map((account) => (
              <AccountRow
                key={account.email}
                account={account}
                onRename={refresh}
                onRemove={refresh}
              />
            ))}
            {adding ? (
              <AddAccountForm
                onAdded={() => {
                  setAdding(false);
                  refresh();
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="self-start inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm border border-border text-[12px] hover:bg-foreground/[0.04]"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                Add Gmail account
              </button>
            )}
          </>
        )}
        {error && (
          <div className="px-3 py-2 rounded-sm border border-red-500/30 bg-red-500/[0.03]">
            <p className="font-mono text-[11px] text-red-500 break-all">
              {error}
            </p>
          </div>
        )}
      </div>
    </SettingsGroup>
  );
}

function AccountRow({
  account,
  onRename,
  onRemove,
}: {
  account: AccountInfo;
  onRename: () => void;
  onRemove: () => void;
}) {
  const [busy, setBusy] = useState<"idle" | "syncing" | "removing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);

  async function handleDisplayNameChange(nextName: string) {
    if (nextName.trim() === account.displayName) return;
    setError(null);
    try {
      await tauriInvoke<AccountInfo>("gmail_account_update", {
        email: account.email,
        displayName: nextName.trim(),
        senderName: null,
      });
      onRename();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSenderNameChange(nextName: string) {
    const trimmed = nextName.trim();
    if (trimmed === account.senderName) return;
    setError(null);
    try {
      await tauriInvoke<AccountInfo>("gmail_account_update", {
        email: account.email,
        displayName: null,
        senderName: trimmed,
      });
      onRename();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRemove() {
    setBusy("removing");
    setError(null);
    try {
      await tauriInvoke<void>("gmail_account_remove", { email: account.email });
      onRemove();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  async function handleSync() {
    setBusy("syncing");
    setError(null);
    try {
      const result = await tauriInvoke<SyncResult>("gmail_sync_recent", {
        accountEmail: account.email,
        limit: 20,
      });
      if (result) setLastSync(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-sm border border-border">
        <div className="min-w-0 flex-1">
          <EditableLine
            value={account.displayName}
            onCommit={handleDisplayNameChange}
            className="text-[13px] text-foreground font-medium"
            placeholder={account.email}
          />
          <p className="font-mono text-[11px] text-muted-foreground truncate">
            {account.email}
          </p>
          <div className="mt-1 flex items-baseline gap-1.5 min-w-0">
            <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
              Sends as:
            </span>
            <div className="min-w-0 flex-1">
              <EditableLine
                value={account.senderName}
                onCommit={handleSenderNameChange}
                className="text-[12px] text-foreground"
                placeholder="(bare email — click to add a sender name)"
                allowEmpty
              />
            </div>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            type="button"
            onClick={handleSync}
            disabled={busy !== "idle"}
            className="px-3 py-1.5 rounded-sm bg-foreground text-background text-[12px] font-medium disabled:opacity-50"
          >
            {busy === "syncing" ? "Syncing…" : "Sync"}
          </button>
          <button
            type="button"
            onClick={handleRemove}
            disabled={busy !== "idle"}
            aria-label="Disconnect account"
            title="Disconnect"
            className="inline-flex items-center justify-center h-7 w-7 rounded-sm border border-border text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      {lastSync && (
        <p className="font-mono text-[11px] text-muted-foreground px-3">
          Last sync: fetched {lastSync.fetched}, wrote {lastSync.written.length}{" "}
          in {lastSync.durationMs}ms
        </p>
      )}
      {error && (
        <p className="font-mono text-[11px] text-red-500 px-3 break-all">
          {error}
        </p>
      )}
    </div>
  );
}

function AddAccountForm({
  onAdded,
  onCancel,
}: {
  onAdded: () => void;
  onCancel: () => void;
}) {
  const [emailDraft, setEmailDraft] = useState("");
  const [pwDraft, setPwDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [senderDraft, setSenderDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await tauriInvoke<AccountInfo>("gmail_account_set", {
        input: {
          email: emailDraft.trim(),
          appPassword: pwDraft.trim(),
          displayName: nameDraft.trim() || null,
          senderName: senderDraft.trim() || null,
        },
      });
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSave}
      className="flex flex-col gap-2 px-3 py-3 rounded-sm border border-border bg-foreground/[0.02]"
    >
      <label className="text-[12px] text-muted-foreground">
        Display name
        <span className="block text-[10px] text-muted-foreground/70 mt-0.5">
          Label shown in the inbox dropdown — your label, only seen in Woodshed.
        </span>
        <input
          type="text"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          placeholder="Personal · Work · etc."
          className="mt-1 w-full px-2 py-1.5 rounded-sm border border-border bg-background font-mono text-[12px]"
        />
      </label>
      <label className="text-[12px] text-muted-foreground">
        Sender name
        <span className="block text-[10px] text-muted-foreground/70 mt-0.5">
          What recipients see in the &quot;From:&quot; field. Leave blank to send as bare email.
        </span>
        <input
          type="text"
          value={senderDraft}
          onChange={(e) => setSenderDraft(e.target.value)}
          placeholder="Alex Example"
          className="mt-1 w-full px-2 py-1.5 rounded-sm border border-border bg-background font-mono text-[12px]"
        />
      </label>
      <label className="text-[12px] text-muted-foreground">
        Email
        <input
          type="email"
          value={emailDraft}
          onChange={(e) => setEmailDraft(e.target.value)}
          required
          placeholder="you@gmail.com"
          className="mt-1 w-full px-2 py-1.5 rounded-sm border border-border bg-background font-mono text-[12px]"
        />
      </label>
      <div className="text-[12px] text-muted-foreground">
        <label htmlFor="gmail-app-password">App password</label>
        <p className="mt-0.5 text-[10px] text-muted-foreground/70">
          Create a 16-character password at{" "}
          <a
            href="https://myaccount.google.com/apppasswords"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground hover:no-underline"
          >
            myaccount.google.com/apppasswords
            <ExternalLink className="h-2.5 w-2.5" strokeWidth={1.75} />
          </a>
          .
        </p>
        <input
          id="gmail-app-password"
          type="password"
          value={pwDraft}
          onChange={(e) => setPwDraft(e.target.value)}
          required
          placeholder="16-character app password"
          className="mt-1 w-full px-2 py-1.5 rounded-sm border border-border bg-background font-mono text-[12px]"
        />
      </div>
      <div className="flex gap-2 mt-1">
        <button
          type="submit"
          disabled={saving}
          className="px-3 py-1.5 rounded-sm bg-foreground text-background text-[12px] font-medium disabled:opacity-50"
        >
          {saving ? "Saving…" : "Connect"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1.5 rounded-sm border border-border text-[12px] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="font-mono text-[11px] text-red-500 break-all mt-1">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Click-to-edit text field. Renders as a button by default; clicking
 * swaps to an input. Enter or blur commits; Escape cancels.
 *
 * `allowEmpty` controls whether commit is allowed when the input is
 * blank: false (default) reverts blank commits to the original value
 * (used for display name — empty falls back to email at render time
 * anyway, but the user's keystrokes shouldn't blank-out the label by
 * accident); true permits explicit clearing (used for sender name —
 * empty is a meaningful "send as bare email" signal).
 */
function EditableLine({
  value,
  onCommit,
  className = "",
  placeholder,
  allowEmpty = false,
}: {
  value: string;
  onCommit: (next: string) => void;
  className?: string;
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }
  }, [editing]);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next === value) {
      setDraft(value);
      return;
    }
    if (!next && !allowEmpty) {
      setDraft(value);
      return;
    }
    onCommit(next);
  }

  function cancel() {
    setEditing(false);
    setDraft(value);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        className={`w-full bg-transparent outline-none border-b border-foreground/30 -mb-px ${className}`}
      />
    );
  }

  // Empty value: show placeholder text in muted color, still clickable.
  const hasValue = value.trim().length > 0;
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={`text-left rounded-sm -mx-1 px-1 hover:bg-foreground/[0.05] transition-colors truncate w-full ${
        hasValue ? className : "text-muted-foreground italic"
      }`}
    >
      {hasValue ? value : (placeholder ?? "—")}
    </button>
  );
}
