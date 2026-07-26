import { useEffect, useState } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";

// TanStack Router's root errorComponent. Equivalent of the old
// app/error.tsx + app/global-error.tsx. Renders a copyable error blob
// instead of a white screen — desktop users have no devtools console
// to inspect, so the trace has to be visible and shareable.
export function RootErrorBoundary({ error, reset }: ErrorComponentProps) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[woodshed] route-error caught:", error);
  }, [error]);

  const [copied, setCopied] = useState(false);
  const err = error as Error & { digest?: string };
  const blob = formatError(err);

  async function copy() {
    try {
      await navigator.clipboard.writeText(blob);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="max-w-[760px] mx-auto p-8">
        <h1 className="text-lg font-semibold mb-2">This page hit an error</h1>
        <p className="text-sm text-muted-foreground mb-4">
          Your vault files are safe. Copy the trace, then try again.
        </p>
        <pre className="bg-foreground/[0.04] border border-border rounded-md p-3 overflow-auto max-h-[360px] whitespace-pre-wrap break-all font-mono text-[11px] leading-snug">
          {blob}
        </pre>
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={copy}
            className="px-3 py-1.5 rounded-sm border border-border text-[12px] hover:bg-foreground/[0.04]"
          >
            {copied ? "Copied" : "Copy error"}
          </button>
          <button
            type="button"
            onClick={reset}
            className="px-3 py-1.5 rounded-sm bg-foreground text-background text-[12px] font-medium"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

function formatError(error: Error & { digest?: string }): string {
  const lines: string[] = [];
  lines.push(`message: ${error.message ?? "(no message)"}`);
  if (error.name && error.name !== "Error") lines.push(`name:    ${error.name}`);
  if (error.digest) lines.push(`digest:  ${error.digest}`);
  lines.push(`url:     ${typeof window !== "undefined" ? window.location.href : "?"}`);
  lines.push(`time:    ${new Date().toISOString()}`);
  if (error.stack) lines.push("", "stack:", error.stack);
  return lines.join("\n");
}
