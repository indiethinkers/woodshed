"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SweepCard } from "@/lib/sweep/types";

// The persistent "talk to the card" composer. Rendered in the ContentPanel's
// floating footer slot. v1 scope is the focused card; a Broader/Narrower scope
// toggle is sketched in the design and deferred.
export function CommandBar({
  card,
  busy,
  onSubmit,
}: {
  card: SweepCard;
  busy: boolean;
  onSubmit: (instruction: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState("");

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setValue("");
    await onSubmit(trimmed);
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-[#d8d0c1] bg-[#fffdf8]/95 p-3 shadow-[0_18px_45px_rgba(32,24,10,0.13),0_1px_0_rgba(255,255,255,0.85)_inset] backdrop-blur dark:border-border dark:bg-background/95 dark:shadow-lg">
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 bg-[#b8824a] dark:bg-blue-500"
      />
      <div className="mb-2 flex items-center gap-2 px-1 pl-2 text-xs text-muted-foreground">
        <span>Talking to:</span>
        <span className="max-w-md truncate rounded bg-[#eee7da] px-1.5 py-0.5 font-medium text-foreground shadow-[0_1px_0_rgba(255,255,255,0.6)_inset] dark:bg-muted">
          {card.headline || card.subject}
        </span>
      </div>
      <div className="flex items-end gap-2">
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Tell Motif what to notice, change, or do…"
          rows={1}
          disabled={busy}
          className="min-h-11 flex-1 resize-none rounded-lg border-[#ddd4c5] bg-white px-3 py-2.5 text-[15px] shadow-[0_1px_0_rgba(255,255,255,0.9)_inset] placeholder:text-muted-foreground/80 focus-visible:border-[#b8824a] focus-visible:ring-[#b8824a]/20 dark:border-input dark:bg-input/30 dark:focus-visible:border-ring dark:focus-visible:ring-ring/50"
        />
        <Button
          onClick={() => void submit()}
          disabled={busy || !value.trim()}
          className="h-11 rounded-lg bg-[#24231f] px-4 text-[15px] text-white shadow-[0_8px_18px_rgba(32,24,10,0.22)] hover:bg-black dark:bg-primary dark:text-primary-foreground"
        >
          {busy && <Loader2 className="animate-spin" />}
          Send
        </Button>
      </div>
    </div>
  );
}
