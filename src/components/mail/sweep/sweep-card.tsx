"use client";

import { useEffect, useState } from "react";
import {
  Archive,
  Clock,
  ListTodo,
  Send,
  SkipForward,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SweepCard } from "@/lib/sweep/types";

interface Props {
  card: SweepCard;
  busy: boolean;
  onSend: (draft: string) => void;
  onArchive: () => void;
  onTask: () => void;
  onPerson: () => void;
  onSnooze: () => void;
  onSkip: () => void;
  onDraftChange: (draft: string) => void;
}

function eyebrowDate(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function SweepCardView(props: Props) {
  const { card, busy } = props;
  const [draft, setDraft] = useState(card.draft);

  // Reset the local draft when the card changes (the key prop also remounts).
  useEffect(() => {
    setDraft(card.draft);
  }, [card.id, card.draft]);

  const actionHasDraft =
    card.actionKind === "reply" || card.actionKind === "forward";
  const hasDraft = actionHasDraft || draft.trim().length > 0;
  const recommended = hasDraft && !actionHasDraft ? "reply" : card.actionKind;
  const draftLabel = actionHasDraft ? card.actionLabel || "Draft" : "Draft reply";
  const date = eyebrowDate(card.emailDate);
  const actionClass = (active: boolean) =>
    active
      ? "border-[#25231e] bg-[#25231e] text-white shadow-[0_8px_18px_rgba(32,24,10,0.18)] hover:bg-black dark:border-primary dark:bg-primary dark:text-primary-foreground"
      : "border-[#d8d0c1] bg-[#fffaf0] text-[#34302a] shadow-[0_1px_0_rgba(255,255,255,0.75)_inset] hover:border-[#b8824a]/60 hover:bg-[#f6efe3] dark:border-border dark:bg-background dark:text-foreground dark:hover:bg-muted";

  return (
    <div className="relative overflow-hidden rounded-lg border border-[#d8d0c1] bg-[#fffdf8] px-8 py-7 shadow-[0_18px_60px_rgba(32,24,10,0.10),0_1px_0_rgba(255,255,255,0.85)_inset] dark:border-border dark:bg-background">
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 bg-blue-500"
      />
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="size-1.5 rounded-full bg-blue-500/70" />
        {date ? `INBOX · ${date}` : "INBOX"}
      </div>

      <h1 className="mt-3 font-serif text-2xl leading-tight text-foreground">
        {card.headline || card.subject || "(untitled)"}
      </h1>

      {card.whatHappened && (
        <section className="mt-6">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What happened
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-foreground/90">
            {card.whatHappened}
          </p>
        </section>
      )}

      {hasDraft && (
        <section className="mt-6">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {draftLabel}
          </h2>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => props.onDraftChange(draft)}
            rows={6}
            className="mt-2 resize-y rounded-lg border-[#ddd4c5] bg-white text-[15px] leading-relaxed shadow-[0_1px_0_rgba(255,255,255,0.9)_inset] focus-visible:border-[#b8824a] focus-visible:ring-[#b8824a]/20 dark:border-input dark:bg-input/30 dark:focus-visible:border-ring dark:focus-visible:ring-ring/50"
          />
        </section>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-2">
        {hasDraft && (
          <Button
            size="sm"
            variant="outline"
            className={actionClass(
              recommended === "reply" || recommended === "forward",
            )}
            onClick={() => props.onSend(draft)}
            disabled={busy || !draft.trim()}
          >
            <Send /> Send
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className={actionClass(recommended === "task")}
          onClick={props.onTask}
          disabled={busy}
        >
          <ListTodo /> Create task
        </Button>
        {(card.actionKind === "person" || recommended === "person") && (
          <Button
            size="sm"
            variant="outline"
            className={actionClass(recommended === "person")}
            onClick={props.onPerson}
            disabled={busy}
          >
            <UserRound /> Update person
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className={actionClass(recommended === "archive")}
          onClick={props.onArchive}
          disabled={busy}
        >
          <Archive /> Archive
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={actionClass(recommended === "snooze")}
          onClick={props.onSnooze}
          disabled={busy}
        >
          <Clock /> Snooze
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-[#4d4941] hover:bg-[#f1eadf] hover:text-foreground dark:text-muted-foreground dark:hover:bg-muted"
          onClick={props.onSkip}
          disabled={busy}
        >
          <SkipForward /> Skip
        </Button>
      </div>
    </div>
  );
}
