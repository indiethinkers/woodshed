import { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  Plus,
  RefreshCw,
  X,
  AlertCircle,
  ExternalLink as ExternalLinkIcon,
} from "lucide-react";
import { ExternalAnchor } from "@/components/shared/external-link";
import { SettingsGroup } from "@/components/settings/settings-page";
import {
  useGcalAccounts,
  useGcalAccountMutations,
  useGcalSyncOne,
  type GcalAccountInfo,
} from "@/lib/hooks/use-gcal";

/**
 * Google Calendars (Phase 2a — iCal subscription, read-only).
 * One compact row per calendar: color dot, name, last-sync timestamp,
 * sync + remove. Errors from the most recent sync render inline
 * underneath the row in red. The iCal URL itself isn't shown again
 * after add — once it's in the keychain we don't want it visible.
 */
const PALETTE: { name: string; hex: string }[] = [
  { name: "Tomato", hex: "#FF6B6B" },
  { name: "Tangerine", hex: "#F9A03F" },
  { name: "Banana", hex: "#F5C518" },
  { name: "Sage", hex: "#52B788" },
  { name: "Peacock", hex: "#1D9BF0" },
  { name: "Lavender", hex: "#A78BFA" },
  { name: "Grape", hex: "#7C3AED" },
  { name: "Graphite", hex: "#6B7280" },
];
const GOOGLE_CALENDAR_SETTINGS_URL =
  "https://calendar.google.com/calendar/r/settings";

export function GcalAccountSection() {
  const { data: accounts, isLoading, error: loadError } = useGcalAccounts();
  const [adding, setAdding] = useState(false);

  return (
    <SettingsGroup
      label="Google Calendars"
      description="Subscribe to a Google Calendar by its private iCal URL. Events appear on Cadence pages alongside vault-local events — read-only; edits live in Google. Click Sync (on this row, or on the Cadence page) to pull the latest events."
    >
      <div className="flex flex-col gap-2 max-w-[560px]">
        {isLoading ? (
          <p className="font-mono text-[12px] text-muted-foreground">Loading…</p>
        ) : (
          <>
            {(accounts ?? []).length === 0 && !adding && (
              <p className="text-[12px] text-muted-foreground">
                No calendars connected yet.
              </p>
            )}
            {(accounts ?? []).map((account) => (
              <AccountRow key={account.id} account={account} />
            ))}
            {adding ? (
              <AddCalendarForm onDone={() => setAdding(false)} />
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="self-start inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm border border-border text-[12px] hover:bg-foreground/[0.04]"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                Add calendar
              </button>
            )}
          </>
        )}
        {loadError && (
          <p className="font-mono text-[11px] text-red-500 break-all">
            {loadError instanceof Error ? loadError.message : String(loadError)}
          </p>
        )}
      </div>
    </SettingsGroup>
  );
}

function AccountRow({ account }: { account: GcalAccountInfo }) {
  const { update, remove } = useGcalAccountMutations();
  const sync = useGcalSyncOne();
  const [renameError, setRenameError] = useState<string | null>(null);

  const status = account.lastError
    ? "error"
    : account.lastSyncedAt
      ? "ok"
      : "pending";

  async function handleColorPick(hex: string) {
    if (hex === account.color) return;
    try {
      await update.mutateAsync({ accountId: account.id, color: hex });
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRename(nextName: string) {
    if (nextName.trim() === account.displayName) return;
    setRenameError(null);
    try {
      await update.mutateAsync({
        accountId: account.id,
        displayName: nextName.trim(),
      });
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleEmailsChange(next: string) {
    const parsed = parseEmailsInput(next);
    // Compare against current (canonicalized) — bail if nothing changed.
    if (
      parsed.length === account.emails.length &&
      parsed.every((e, i) => e === account.emails[i])
    ) {
      return;
    }
    setRenameError(null);
    try {
      await update.mutateAsync({
        accountId: account.id,
        emails: parsed,
      });
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRemove() {
    try {
      await remove.mutateAsync({ accountId: account.id });
    } catch {}
  }

  async function handleSync() {
    try {
      await sync.mutateAsync({ accountId: account.id });
    } catch {}
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2.5 px-3 py-2 rounded-sm border border-border min-w-0">
        <ColorPicker color={account.color} onPick={handleColorPick} />
        <div className="min-w-0 flex-1">
          <EditableLine
            value={account.displayName}
            placeholder="(untitled)"
            onCommit={handleRename}
            className="text-[13px] text-foreground font-medium"
          />
          <EditableLine
            value={account.emails.join(", ")}
            placeholder="Your email on this calendar — comma-separated for multiple"
            onCommit={handleEmailsChange}
            className="text-[11px] text-muted-foreground font-mono"
            allowEmpty
          />
          <p className="font-mono text-[11px] text-muted-foreground truncate">
            <StatusLabel
              status={status}
              syncedAt={account.lastSyncedAt}
              busy={sync.isPending}
            />
          </p>
        </div>
        <button
          type="button"
          onClick={handleSync}
          disabled={sync.isPending}
          aria-label="Sync now"
          title="Sync now"
          className="inline-flex items-center justify-center h-7 w-7 rounded-sm border border-border text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${sync.isPending ? "animate-spin" : ""}`}
            strokeWidth={1.75}
          />
        </button>
        <button
          type="button"
          onClick={handleRemove}
          disabled={remove.isPending}
          aria-label="Disconnect calendar"
          title="Disconnect"
          className="inline-flex items-center justify-center h-7 w-7 rounded-sm border border-border text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {account.lastError && (
        <div className="flex items-start gap-1.5 px-3 pt-1">
          <AlertCircle
            className="h-3 w-3 mt-[3px] text-red-500 shrink-0"
            strokeWidth={2}
          />
          <p className="font-mono text-[11px] text-red-500 break-all leading-snug">
            {account.lastError}
          </p>
        </div>
      )}
      {renameError && (
        <p className="font-mono text-[11px] text-red-500 break-all px-3 pt-1">
          {renameError}
        </p>
      )}
    </div>
  );
}

function StatusLabel({
  status,
  syncedAt,
  busy,
}: {
  status: "ok" | "error" | "pending";
  syncedAt: string | null;
  busy: boolean;
}) {
  if (busy) return <>Syncing…</>;
  if (status === "ok" && syncedAt) return <>Synced {formatRelative(syncedAt)}</>;
  if (status === "error" && syncedAt) {
    return <>Last sync failed · previously synced {formatRelative(syncedAt)}</>;
  }
  if (status === "error") return <>Last sync failed</>;
  return <>Not yet synced</>;
}

function ColorPicker({
  color,
  onPick,
}: {
  color: string;
  onPick: (hex: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label="Pick calendar color"
        className="inline-flex items-center justify-center shrink-0 h-5 w-5 rounded-full hover:scale-105 transition-transform"
        style={{
          backgroundColor: color || "#6B7280",
          boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.06)",
        }}
      />
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start">
          <Popover.Popup className="bg-popover text-popover-foreground border border-border rounded-lg shadow-lg outline-none p-2 flex gap-1.5">
            {PALETTE.map((swatch) => (
              <button
                key={swatch.hex}
                type="button"
                onClick={() => {
                  onPick(swatch.hex);
                  setOpen(false);
                }}
                title={swatch.name}
                aria-label={swatch.name}
                className="inline-block h-5 w-5 rounded-full hover:scale-110 transition-transform"
                style={{
                  backgroundColor: swatch.hex,
                  boxShadow:
                    swatch.hex.toLowerCase() === color.toLowerCase()
                      ? "0 0 0 2px var(--foreground), 0 0 0 3px var(--background)"
                      : "inset 0 0 0 1px rgba(0,0,0,0.06)",
                }}
              />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AddCalendarForm({ onDone }: { onDone: () => void }) {
  const { add } = useGcalAccountMutations();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [emails, setEmails] = useState("");
  const [color, setColor] = useState(PALETTE[0].hex);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await add.mutateAsync({
        url: url.trim(),
        displayName: name.trim() || "Untitled calendar",
        color,
        emails: parseEmailsInput(emails),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 px-3 py-3 rounded-sm border border-border bg-foreground/[0.02]"
    >
      <div className="flex items-center gap-2">
        <ColorPicker color={color} onPick={setColor} />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Calendar name (Work, Personal, …)"
          className="flex-1 min-w-0 px-2 py-1.5 rounded-sm border border-border bg-background text-[13px]"
        />
      </div>
      <div>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          className="w-full px-2.5 py-2 rounded-sm border border-border bg-background font-mono text-[13px]"
        />
        <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
          Google Calendar → ⚙ Settings → [Calendar] → Integrate calendar →
          &quot;Secret address in iCal format.&quot;
        </p>
        <ExternalAnchor
          href={GOOGLE_CALENDAR_SETTINGS_URL}
          className="mt-1.5 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground underline underline-offset-2 hover:text-foreground hover:no-underline"
        >
          Open Google Calendar settings
          <ExternalLinkIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </ExternalAnchor>
      </div>
      <div>
        <input
          type="text"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder="Your email(s) on this calendar — comma-separated"
          className="w-full px-2.5 py-2 rounded-sm border border-border bg-background font-mono text-[13px]"
        />
        <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
          Used to filter out declined events and events you&apos;re not on
          (matches Google&apos;s own UI). Leave blank to surface every event in
          the feed.
        </p>
      </div>
      <div className="flex gap-2 mt-1">
        <button
          type="submit"
          disabled={add.isPending}
          className="px-3 py-1.5 rounded-sm bg-foreground text-background text-[12px] font-medium disabled:opacity-50"
        >
          {add.isPending ? "Adding…" : "Add calendar"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={add.isPending}
          className="px-3 py-1.5 rounded-sm border border-border text-[12px] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {error && (
        <div className="flex items-start gap-1.5 mt-1">
          <AlertCircle
            className="h-3 w-3 mt-[3px] text-red-500 shrink-0"
            strokeWidth={2}
          />
          <p className="font-mono text-[11px] text-red-500 break-all leading-snug">
            {error}
          </p>
        </div>
      )}
    </form>
  );
}

/** Split a comma/whitespace-separated email string into a normalized
 *  list: trimmed, lowercased, empty-dropped. */
function parseEmailsInput(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Click-to-edit inline text. Enter or blur commits; Escape cancels.
 * Empty commits revert to the previous value by default (display
 * names should always be non-empty). Pass `allowEmpty` to permit
 * clearing (used for the per-calendar emails field — clearing means
 * "no filter").
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
            setEditing(false);
            setDraft(value);
          }
        }}
        className={`w-full bg-transparent outline-none border-b border-foreground/30 -mb-px ${className}`}
      />
    );
  }

  const hasValue = value.trim().length > 0;
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to rename"
      className={`text-left rounded-sm -mx-1 px-1 hover:bg-foreground/[0.05] transition-colors truncate w-full ${
        hasValue ? className : "text-muted-foreground italic"
      }`}
    >
      {hasValue ? value : (placeholder ?? "—")}
    </button>
  );
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const sec = Math.round((now - then) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
