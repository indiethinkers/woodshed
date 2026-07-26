import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, FolderOpen, RefreshCw, FileText } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { SettingsPage, SettingsGroup } from "@/components/settings/settings-page";
import { useReindex } from "@/lib/hooks/use-search";
import { tauriInvoke, isTauri } from "@/lib/tauri";

export const Route = createFileRoute("/settings/vault")({
  component: VaultSettingsPage,
});

function VaultSettingsPage() {
  const [vaultPath, setVaultPath] = useState<string>("");
  const [logPath, setLogPath] = useState<string>("");
  const [logPathCopied, setLogPathCopied] = useState(false);
  const [logTail, setLogTail] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [lastIndexed, setLastIndexed] = useState<number | null>(null);
  const reindex = useReindex();
  const qc = useQueryClient();

  useEffect(() => {
    tauriInvoke<string | null>("vault_path_get").then((p) => {
      if (p) setVaultPath(p);
    });
    tauriInvoke<string | null>("logs_path").then((p) => {
      if (p) setLogPath(p);
    });
  }, []);

  async function openInFinder() {
    if (!isTauri() || !vaultPath) return;
    await tauriInvoke<void>("vault_reveal");
  }

  async function openLogInFinder() {
    if (!isTauri() || !logPath) return;
    await tauriInvoke<void>("logs_open");
  }

  async function showLogTail() {
    const text = await tauriInvoke<string>("logs_tail", { lines: 200 });
    setLogTail(text ?? "");
  }

  async function copyLogPath() {
    if (!logPath) return;
    await navigator.clipboard.writeText(logPath);
    setLogPathCopied(true);
    window.setTimeout(() => setLogPathCopied(false), 1400);
  }

  async function resetAndRescan() {
    if (!vaultPath) return;
    try {
      await tauriInvoke<void>("vault_init", {
        path: vaultPath,
        seedSamples: false,
      });
      const count = await reindex.mutateAsync();
      setLastIndexed(count ?? null);
      qc.invalidateQueries();
    } finally {
      setConfirming(false);
    }
  }

  return (
    <SettingsPage section="Vault">
      <SettingsGroup label="Location">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 px-2 py-1 rounded-sm bg-muted font-mono text-[14px] text-foreground break-all">
            {vaultPath || "(not configured)"}
          </span>
          <button
            type="button"
            onClick={openInFinder}
            disabled={!vaultPath}
            className="h-7 px-3 inline-flex items-center gap-1.5 rounded-sm border border-border text-[13px] text-foreground hover:bg-muted disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open in Finder
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        label="Maintenance"
        description="Rebuild the index from your vault files. Use this if Woodshed feels out of sync."
      >
        {!confirming ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="h-7 px-3 inline-flex items-center gap-1.5 self-start rounded-sm border border-border text-[13px] text-foreground hover:bg-muted"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reset &amp; re-scan
            </button>
            {lastIndexed !== null && (
              <span className="text-[12px] text-muted-foreground">
                {lastIndexed} files indexed
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-foreground">
              {reindex.isPending ? "Re-scanning…" : "Confirm rebuild?"}
            </span>
            <button
              type="button"
              onClick={resetAndRescan}
              disabled={reindex.isPending}
              className="h-7 px-3 rounded-sm bg-accent text-accent-foreground text-[13px] disabled:opacity-50"
            >
              Yes, rebuild
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={reindex.isPending}
              className="h-7 px-3 rounded-sm border border-border text-[13px] text-foreground hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        label="Diagnostics"
        description="Quick access to the local Rust process log."
      >
        <div className="overflow-hidden rounded-md border border-border bg-background/55 shadow-[0_1px_0_color-mix(in_srgb,var(--foreground)_5%,transparent)]">
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm border border-border bg-muted/45 text-muted-foreground">
                <FileText className="size-4" />
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-foreground">
                  woodshed.log
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                  Command failures, calendar syncs, and browser errors.
                </div>
              </div>
            </div>

            <div className="flex min-w-0 items-center gap-2 rounded-sm border border-border/70 bg-muted/45 px-2.5 py-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] leading-5 text-foreground/85">
                {logPath || "(no log path yet)"}
              </code>
              <button
                type="button"
                onClick={copyLogPath}
                disabled={!logPath}
                aria-label="Copy log path"
                title="Copy log path"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-40"
              >
                {logPathCopied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={openLogInFinder}
                disabled={!logPath}
                className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-border bg-background/70 px-3 text-[13px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Open log
              </button>
              <button
                type="button"
                onClick={showLogTail}
                disabled={!logPath}
                className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-border bg-background/70 px-3 text-[13px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                <FileText className="h-3.5 w-3.5" />
                Show last 200 lines
              </button>
            </div>
          </div>

          {logTail !== null && (
            <div className="border-t border-border bg-muted/20 p-3">
              <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Last 200 lines
              </div>
              <pre className="max-h-[360px] w-full overflow-auto rounded-sm border border-border/70 bg-background p-3 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all">
                {logTail || "(log is empty)"}
              </pre>
            </div>
          )}
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
