import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  PlugZap,
  Save,
  Trash2,
} from "lucide-react";
import { SettingsGroup } from "@/components/settings/settings-page";
import { isLoopbackAgentUrl } from "@/lib/agent/connection";
import { tauriInvoke } from "@/lib/tauri";

interface AgentConfig {
  displayName: string;
  baseUrl: string;
  model: string;
  sessionKey: string;
  hasApiKey: boolean;
  credentialSource: "environment" | "hermes" | "stored" | "missing";
  managedProfile: {
    name: string;
    port: number;
    model: string;
  } | null;
}

interface AgentConnectionTestResult {
  ok: boolean;
  status: number;
  modelFound: boolean;
  models: string[];
  message: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  displayName: "Hermes",
  baseUrl: "http://127.0.0.1:8642/v1",
  model: "hermes-agent",
  sessionKey: "woodshed",
  hasApiKey: false,
  credentialSource: "missing",
  managedProfile: {
    name: "default",
    port: 8642,
    model: "hermes-agent",
  },
};
const MASKED_KEY_VALUE = "configured-password";

export function AgentSettingsSection() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [displayName, setDisplayName] = useState(DEFAULT_CONFIG.displayName);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_CONFIG.baseUrl);
  const [model, setModel] = useState(DEFAULT_CONFIG.model);
  const [sessionKey, setSessionKey] = useState(DEFAULT_CONFIG.sessionKey);
  const [apiKey, setApiKey] = useState("");
  const [isReplacingKey, setIsReplacingKey] = useState(false);
  const [editingCustomEndpoint, setEditingCustomEndpoint] = useState(false);
  const [busy, setBusy] = useState<"idle" | "saving" | "testing" | "clearing">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [testResult, setTestResult] =
    useState<AgentConnectionTestResult | null>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    tauriInvoke<AgentConfig>("agent_config_get")
      .then((next) => {
        if (cancelled) return;
        applyConfig(next ?? DEFAULT_CONFIG);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        applyConfig(DEFAULT_CONFIG);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function applyConfig(next: AgentConfig) {
    setConfig(next);
    setDisplayName(next.displayName || DEFAULT_CONFIG.displayName);
    setBaseUrl(next.baseUrl || DEFAULT_CONFIG.baseUrl);
    setModel(next.model || DEFAULT_CONFIG.model);
    setSessionKey(next.sessionKey || DEFAULT_CONFIG.sessionKey);
    setApiKey("");
    setIsReplacingKey(false);
    setEditingCustomEndpoint(false);
    setConnectionError(null);
  }

  async function saveDraft() {
    const next = await tauriInvoke<AgentConfig>("agent_config_set", {
      input: {
        displayName: displayName.trim() || DEFAULT_CONFIG.displayName,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        sessionKey: sessionKey.trim() || DEFAULT_CONFIG.sessionKey,
        apiKey: apiKey.trim() || null,
      },
    });
    applyConfig(next ?? DEFAULT_CONFIG);
    return next ?? DEFAULT_CONFIG;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy("saving");
    setError(null);
    setTestResult(null);
    try {
      await saveDraft();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  async function handleSaveAndTest() {
    setBusy("testing");
    setError(null);
    setTestResult(null);
    try {
      await saveDraft();
      const result = await tauriInvoke<AgentConnectionTestResult>(
        "agent_connection_test",
      );
      setTestResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  async function handleTestConnection() {
    setBusy("testing");
    setConnectionError(null);
    setTestResult(null);
    try {
      const result = await tauriInvoke<AgentConnectionTestResult>(
        "agent_connection_test",
      );
      setTestResult(result);
    } catch (e) {
      setConnectionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  async function handleClear() {
    setBusy("clearing");
    setError(null);
    setTestResult(null);
    try {
      const next = await tauriInvoke<AgentConfig>("agent_config_clear");
      applyConfig(next ?? DEFAULT_CONFIG);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  const hasKey = config?.hasApiKey ?? false;
  const credentialSource = config?.credentialSource ?? "missing";
  const isLocalHermes = isLoopbackAgentUrl(baseUrl);
  const managedProfile = config?.managedProfile ?? DEFAULT_CONFIG.managedProfile;
  const followsHermesProfile = config === null || config.managedProfile !== null;
  const connectionMode: "default" | "local" | "remote" =
    followsHermesProfile && !editingCustomEndpoint
      ? "default"
      : isLocalHermes
        ? "local"
        : "remote";
  const managedByHermes = connectionMode === "default";
  const managedProfileName = managedProfile?.name ?? "default";
  const managedProfileLabel =
    managedProfileName === "default"
      ? "Default"
      : `${managedProfileName.charAt(0).toUpperCase()}${managedProfileName.slice(1)}`;
  const managedProfilePort = managedProfile?.port ?? 8642;
  const disabled = busy !== "idle" || config === null;
  const showingStoredKey = hasKey && !isReplacingKey;
  const keyInputValue = showingStoredKey ? MASKED_KEY_VALUE : apiKey;
  const testButtonLabel =
    busy === "testing"
      ? "Testing..."
      : showingStoredKey
        ? "Test"
        : "Save & test";
  const managedStatus =
    busy === "testing"
      ? {
          label: "Checking",
          message: "Contacting the local Hermes gateway…",
          tone: "checking" as const,
        }
      : connectionError
        ? {
            label: "Unavailable",
            message: connectionError,
            tone: "unavailable" as const,
          }
        : testResult?.ok
          ? {
              label: "Connected",
              message: `${managedProfileLabel} is running locally on port ${managedProfilePort} and responding with the configured gateway model.`,
              tone: "connected" as const,
            }
          : testResult
            ? {
                label: "Needs attention",
                message: testResult.message,
                tone: "attention" as const,
              }
            : credentialSource === "missing"
              ? {
                  label: "Setup needed",
                  message: `Woodshed could not find API_SERVER_KEY in the ${managedProfileName} Hermes profile. Configure it in Hermes, then test again.`,
                  tone: "attention" as const,
                }
              : {
                  label: "Not checked",
                  message: `The active Hermes profile is ${managedProfileName} on port ${managedProfilePort}. Test the connection to confirm its gateway is running.`,
                  tone: "neutral" as const,
                };
  const managedCardClass =
    managedStatus.tone === "connected"
      ? "border-emerald-600/25 bg-emerald-600/[0.035]"
      : managedStatus.tone === "unavailable"
        ? "border-red-500/30 bg-red-500/[0.035]"
        : managedStatus.tone === "attention"
          ? "border-amber-500/30 bg-amber-500/[0.035]"
          : "border-border bg-foreground/[0.02]";
  const managedStatusClass =
    managedStatus.tone === "connected"
      ? "bg-emerald-500/10 text-emerald-500"
      : managedStatus.tone === "unavailable"
        ? "bg-red-500/10 text-red-500"
        : managedStatus.tone === "attention" ||
            managedStatus.tone === "checking"
          ? "bg-amber-500/10 text-amber-500"
          : "bg-foreground/[0.055] text-muted-foreground";

  function beginReplacingKey(nextValue = "") {
    setIsReplacingKey(true);
    setApiKey(nextValue);
    requestAnimationFrame(() => keyInputRef.current?.focus());
  }

  return (
    <SettingsGroup
      label="Hermes"
      description={
        managedByHermes
          ? "Woodshed follows the active Hermes profile on this machine. Change its model and provider in Hermes."
          : connectionMode === "local"
            ? "Use an existing Hermes HTTP endpoint on this machine. Woodshed discovers its local profile key."
            : "Connect to a remote Hermes-compatible HTTP endpoint with an explicit bearer key."
      }
    >
      <form onSubmit={handleSave} className="flex max-w-[680px] flex-col gap-4">
        {managedByHermes ? (
          <div className={`rounded-sm border px-3.5 py-3 ${managedCardClass}`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-background/80 text-muted-foreground shadow-sm ring-1 ring-border/70">
                  <Bot aria-hidden="true" className="size-4" strokeWidth={1.8} />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-medium text-foreground">
                      {managedProfileLabel} profile
                    </p>
                    <span
                      aria-live="polite"
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${managedStatusClass}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`size-1.5 rounded-full bg-current ${
                          managedStatus.tone === "checking"
                            ? "animate-pulse"
                            : ""
                        }`}
                      />
                      {managedStatus.label}
                    </span>
                  </div>
                  <p className="mt-1 max-w-[460px] text-[11px] leading-4 text-muted-foreground">
                    {managedStatus.message}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={disabled}
                  className="inline-flex items-center justify-center gap-1.5 rounded-sm border border-border bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
                >
                  <PlugZap className="size-3.5" strokeWidth={1.75} />
                  {busy === "testing" ? "Testing…" : "Test connection"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBaseUrl(
                      `http://127.0.0.1:${managedProfilePort}/v1`,
                    );
                    setEditingCustomEndpoint(true);
                  }}
                  disabled={disabled}
                  className="inline-flex items-center justify-center rounded-sm border border-border bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
                >
                  Use a custom endpoint
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-sm border border-border bg-foreground/[0.02] px-3 py-2.5">
            <div className="flex min-w-0 items-start gap-2.5">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-foreground">
                  {connectionMode === "local"
                    ? "Existing local HTTP"
                    : "Remote HTTP"}
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {connectionMode === "local"
                    ? "Authentication comes from the Hermes profile that owns this local API port."
                    : "Remote endpoints require a bearer key stored privately by Woodshed."}
                </p>
              </div>
            </div>
          </div>
        )}

        <label className="text-[12px] text-muted-foreground">
          Display name
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-[12px] text-foreground"
          />
        </label>

        {!managedByHermes && (
          <>
            <div className="grid gap-3 md:grid-cols-[1fr_180px]">
              <label className="text-[12px] text-muted-foreground">
                Base URL
                <input
                  aria-label="Base URL"
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  required
                  className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground"
                />
              </label>
              <label className="text-[12px] text-muted-foreground">
                Model
                <input
                  aria-label="Model"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  required
                  className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground"
                />
              </label>
            </div>

            {isLocalHermes && !isReplacingKey ? (
              <div className="rounded-sm border border-border bg-foreground/[0.02] px-3 py-2 text-[13px] text-foreground">
                <p>Local authentication</p>
                <p className="mt-1 leading-5 text-muted-foreground">
                  {credentialSource === "hermes"
                    ? "Using API_SERVER_KEY from the matching local Hermes profile. Nothing to paste into Woodshed."
                    : credentialSource === "environment"
                      ? "Using the key from Woodshed's development environment."
                      : credentialSource === "stored"
                        ? "Using the key already stored by Woodshed."
                        : "No matching local Hermes key was found. Configure API_SERVER_KEY in the Hermes profile for this port."}
                </p>
                {(credentialSource === "stored" ||
                  credentialSource === "missing") && (
                  <button
                    type="button"
                    onClick={() => beginReplacingKey("")}
                    disabled={disabled}
                    className="mt-2 text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                  >
                    {credentialSource === "stored"
                      ? "Replace custom key"
                      : "Enter a custom key"}
                  </button>
                )}
              </div>
            ) : (
              <div className="text-[13px] text-foreground">
                <label htmlFor="hermes-token" className="block">
                  {isLocalHermes ? "Custom bearer token" : "Bearer token"}
                </label>
                <div className="relative mt-1">
                  <input
                    id="hermes-token"
                    aria-describedby="hermes-token-help"
                    ref={keyInputRef}
                    type="password"
                    value={keyInputValue}
                    onFocus={() => {
                      if (showingStoredKey) {
                        requestAnimationFrame(() =>
                          keyInputRef.current?.select(),
                        );
                      }
                    }}
                    onChange={(e) => {
                      if (showingStoredKey) {
                        beginReplacingKey("");
                        return;
                      }
                      setApiKey(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (!showingStoredKey) return;
                      if (e.metaKey || e.ctrlKey || e.altKey) return;
                      if (e.key === "Backspace" || e.key === "Delete") {
                        e.preventDefault();
                        beginReplacingKey("");
                        return;
                      }
                      if (e.key.length === 1) {
                        e.preventDefault();
                        beginReplacingKey(e.key);
                      }
                    }}
                    onPaste={(e) => {
                      if (!showingStoredKey) return;
                      e.preventDefault();
                      beginReplacingKey(e.clipboardData.getData("text"));
                    }}
                    placeholder={
                      hasKey ? "Paste replacement token" : "Paste Hermes token"
                    }
                    className="w-full rounded-sm border border-border bg-background px-2.5 py-2 font-mono text-[13px] text-foreground"
                  />
                </div>
                <p
                  id="hermes-token-help"
                  className="mt-2 text-[13px] leading-5 text-muted-foreground"
                >
                  This is the value you set as <code>API_SERVER_KEY</code> when
                  configuring the Hermes API server; Woodshed does not issue it.
                  Paste only the value—without “Bearer” or “Authorization:”—and
                  Woodshed stores it in an owner-only file inside its
                  application-data directory, then adds the authorization header
                  when connecting.
                </p>
              </div>
            )}

            <label className="text-[12px] text-muted-foreground">
              Session key
              <input
                aria-label="Session key"
                type="text"
                value={sessionKey}
                onChange={(e) => setSessionKey(e.target.value)}
                className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground"
              />
            </label>
          </>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-sm bg-foreground px-3 py-1.5 text-[12px] font-medium text-background disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
            {busy === "saving" ? "Saving..." : "Save"}
          </button>
          {!managedByHermes && (
            <>
              <button
                type="button"
                onClick={handleSaveAndTest}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-foreground/[0.04] disabled:opacity-50"
              >
                <PlugZap className="h-3.5 w-3.5" strokeWidth={1.75} />
                {testButtonLabel}
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                {busy === "clearing" ? "Clearing..." : "Clear"}
              </button>
            </>
          )}
        </div>

        {!managedByHermes && testResult && (
          <div
            className={`rounded-sm border px-3 py-2 ${
              testResult.ok
                ? "border-emerald-600/30 bg-emerald-600/[0.04]"
                : "border-amber-500/40 bg-amber-500/[0.05]"
            }`}
          >
            <p className="text-[12px] text-foreground">{testResult.message}</p>
            {testResult.models.length > 0 && (
              <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                models: {testResult.models.join(", ")}
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-1.5 rounded-sm border border-red-500/30 bg-red-500/[0.03] px-3 py-2">
            <AlertCircle
              className="mt-[2px] h-3.5 w-3.5 shrink-0 text-red-500"
              strokeWidth={2}
            />
            <p className="break-all font-mono text-[11px] leading-snug text-red-500">
              {error}
            </p>
          </div>
        )}
      </form>
      <div className="mt-4 max-w-[680px] rounded-md border border-border bg-foreground/[0.02] px-4 py-3">
        <h3 className="text-[13px] font-medium text-foreground">
          What this connection enables
        </h3>
        <ul className="mt-2 space-y-1.5 text-[13px] leading-5 text-muted-foreground">
          <li>• Chat requests go directly from Woodshed to your Hermes endpoint.</li>
          <li>• Remote activity appears in the conversation while Hermes works.</li>
          <li>• Conversations remain readable Markdown files in your vault.</li>
        </ul>
      </div>
    </SettingsGroup>
  );
}
