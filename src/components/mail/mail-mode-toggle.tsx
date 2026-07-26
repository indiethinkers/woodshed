import { Link } from "@tanstack/react-router";
import { Mail, Sparkles } from "lucide-react";

export type MailMode = "inbox" | "sweep";

export function MailModeToggle({ mode }: { mode: MailMode }) {
  const optionClass = (active: boolean) =>
    active
      ? "bg-foreground/[0.08] text-foreground shadow-sm"
      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground";

  return (
    <div
      role="group"
      aria-label="Mail view"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-background/70 p-0.5"
    >
      <Link
        to="/mail"
        search={{}}
        aria-current={mode === "inbox" ? "page" : undefined}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors ${optionClass(mode === "inbox")}`}
      >
        <Mail className="h-3.5 w-3.5" strokeWidth={1.75} />
        Inbox
      </Link>
      <Link
        to="/mail"
        search={{ mode: "sweep" }}
        title="Triage actions send email content to your configured Hermes agent"
        aria-current={mode === "sweep" ? "page" : undefined}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors ${optionClass(mode === "sweep")}`}
      >
        <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
        AI Sweep
      </Link>
    </div>
  );
}
