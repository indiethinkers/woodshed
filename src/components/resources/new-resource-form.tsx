import { useEffect, useRef, useState } from "react";
import { useResourceMutations } from "@/lib/hooks/use-resources";

interface NewResourceFormProps {
  onCreated: () => void;
  onCancel: () => void;
}

/**
 * Inline resource creator. The Rust side derives `source` from the URL host
 * when none is provided, so users can paste a URL and skip the source field.
 * URL capture and future browser extension flows use resource_capture_url;
 * this form stays as the manual fallback.
 */
export function NewResourceForm({ onCreated, onCancel }: NewResourceFormProps) {
  const { create } = useResourceMutations();

  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  async function commit() {
    const trimmedTitle = title.trim();
    const trimmedUrl = url.trim();
    if (!trimmedTitle || !trimmedUrl || create.isPending) return;
    await create.mutateAsync({
      title: trimmedTitle,
      url: trimmedUrl,
    });
    onCreated();
  }

  return (
    <div
      className="space-y-2 rounded-md border border-border bg-background/50 p-3 outline-none"
      onKeyDown={(e) => {
        if (e.key.length === 1 || e.key === "Enter" || e.key === "Escape") {
          e.stopPropagation();
        }
      }}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        New resource
      </p>
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Title"
        className="w-full px-2 h-8 text-sm rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://..."
        className="w-full px-2 h-7 text-[13px] font-mono rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      <div className="flex items-center justify-end gap-1.5 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={create.isPending}
          className="h-7 px-3 rounded-sm text-[13px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={create.isPending || !title.trim() || !url.trim()}
          className="h-7 px-3 rounded-sm bg-accent text-accent-foreground text-[13px] disabled:opacity-50"
        >
          {create.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
