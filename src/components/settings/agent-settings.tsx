import { useEffect, useRef, useState } from "react";
import type { Tool } from "ai";
import { AlertCircle, PlugZap, Save, Trash2 } from "lucide-react";
import {
  Agent,
  AgentContent,
  AgentHeader,
  AgentInstructions,
  AgentOutput,
  AgentTool,
  AgentTools,
} from "@/components/ai-elements/agent";
import { SettingsGroup } from "@/components/settings/settings-page";
import { tauriInvoke } from "@/lib/tauri";

interface AgentConfig {
  displayName: string;
  baseUrl: string;
  model: string;
  sessionKey: string;
  hasApiKey: boolean;
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
  baseUrl: "http://127.0.0.1:8644/v1",
  model: "cadence",
  sessionKey: "woodshed",
  hasApiKey: false,
};
const MASKED_KEY_VALUE = "configured-password";
const AGENT_STREAM_OUTPUT_SCHEMA = `type WoodshedAgentStream =
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning-delta"; textDelta: string }
  | { type: "tool-input" | "tool-output"; toolCallId: string }
  | { type: "source-url"; url: string; title?: string }
  | { type: "finish" };`;
const AGENT_PREVIEW_TOOLS: Array<{ value: string; tool: Tool }> = [
  {
    value: "stream_reasoning",
    tool: previewTool("Stream reasoning and visible remote activity", {
      type: "object",
      properties: {
        delta: { type: "string" },
      },
    }),
  },
  {
    value: "tool_calls",
    tool: previewTool("Render Hermes tool calls with approval states", {
      type: "object",
      properties: {
        toolCallId: { type: "string" },
        input: { type: "object" },
        output: { type: "object" },
      },
    }),
  },
  {
    value: "vault_context",
    tool: previewTool("Persist Agent chats as local markdown records", {
      type: "object",
      properties: {
        sessionKey: { type: "string" },
        chatId: { type: "string" },
      },
    }),
  },
];

function previewTool(description: string, inputSchema: unknown): Tool {
  return { description, inputSchema } as unknown as Tool;
}

export function AgentSettingsSection() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [displayName, setDisplayName] = useState(DEFAULT_CONFIG.displayName);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_CONFIG.baseUrl);
  const [model, setModel] = useState(DEFAULT_CONFIG.model);
  const [sessionKey, setSessionKey] = useState(DEFAULT_CONFIG.sessionKey);
  const [apiKey, setApiKey] = useState("");
  const [isReplacingKey, setIsReplacingKey] = useState(false);
  const [busy, setBusy] = useState<"idle" | "saving" | "testing" | "clearing">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
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
  const disabled = busy !== "idle" || config === null;
  const showingStoredKey = hasKey && !isReplacingKey;
  const keyInputValue = showingStoredKey ? MASKED_KEY_VALUE : apiKey;
  const testButtonLabel =
    busy === "testing" ? "Testing..." : showingStoredKey ? "Test" : "Save & test";

  function beginReplacingKey(nextValue = "") {
    setIsReplacingKey(true);
    setApiKey(nextValue);
    requestAnimationFrame(() => keyInputRef.current?.focus());
  }

  return (
    <SettingsGroup
      label="Hermes"
      description="Connect Woodshed to the Hermes OpenAI-compatible endpoint running on this machine."
    >
      <form onSubmit={handleSave} className="flex max-w-[680px] flex-col gap-4">
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

        <div className="grid gap-3 md:grid-cols-[1fr_180px]">
          <label className="text-[12px] text-muted-foreground">
            Base URL
            <input
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
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
              className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground"
            />
          </label>
        </div>

        <label className="text-[12px] text-muted-foreground">
          Bearer key
          <div className="relative mt-1">
            <input
              ref={keyInputRef}
              type="password"
              value={keyInputValue}
              onFocus={() => {
                if (showingStoredKey) {
                  requestAnimationFrame(() => keyInputRef.current?.select());
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
              placeholder={hasKey ? "Paste replacement key" : "Paste generated key"}
              className="w-full rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground"
            />
          </div>
        </label>

        <label className="text-[12px] text-muted-foreground">
          Session key
          <input
            type="text"
            value={sessionKey}
            onChange={(e) => setSessionKey(e.target.value)}
            className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-sm bg-foreground px-3 py-1.5 text-[12px] font-medium text-background disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
            {busy === "saving" ? "Saving..." : "Save"}
          </button>
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
        </div>

        {testResult && (
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
      <Agent className="mt-6 max-w-[680px] bg-background/40 shadow-none">
        <AgentHeader
          model={model.trim() || DEFAULT_CONFIG.model}
          name={displayName.trim() || DEFAULT_CONFIG.displayName}
        />
        <AgentContent>
          <AgentInstructions>
            {`Woodshed sends Agent conversations to ${baseUrl.trim() || DEFAULT_CONFIG.baseUrl} using session "${sessionKey.trim() || DEFAULT_CONFIG.sessionKey}" and renders structured stream events when Hermes provides them.`}
          </AgentInstructions>
          <AgentTools>
            {AGENT_PREVIEW_TOOLS.map(({ tool, value }) => (
              <AgentTool key={value} tool={tool} value={value} />
            ))}
          </AgentTools>
          <AgentOutput schema={AGENT_STREAM_OUTPUT_SCHEMA} />
        </AgentContent>
      </Agent>
    </SettingsGroup>
  );
}
