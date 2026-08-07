import type { ReactNode } from "react";

export function ListLoadError({
  surface,
  onRetry,
}: {
  surface: string;
  onRetry: () => void;
}) {
  return (
    <>
      <p className="max-w-sm text-sm text-muted-foreground">
        Couldn&apos;t load your {surface}. Your files are safe on disk — this
        is just a hiccup talking to the local backend.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 inline-flex items-center rounded-md border border-border px-2.5 py-1 text-sm text-foreground transition-colors hover:bg-foreground/[0.05]"
      >
        Retry
      </button>
    </>
  );
}
