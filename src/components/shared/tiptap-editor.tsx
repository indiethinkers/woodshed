import { Suspense, lazy } from "react";
import type { TiptapEditorProps } from "./tiptap-editor-impl";
import { useVaultPath } from "@/lib/hooks/use-vault-path";

// Lazy-load the editor implementation. ProseMirror's schema + the 10+
// extensions (StarterKit, Markdown, Wikilink, SlashCommand, YouTube, Twitter,
// etc.) instantiate at ~40-80ms — mounting that synchronously made every
// route transition feel sluggish. With React.lazy(), the page header +
// schedule rail paint immediately, and the editor hydrates in the next
// frame.
const TiptapEditorImpl = lazy(() =>
  import("./tiptap-editor-impl").then((m) => ({ default: m.TiptapEditor })),
);

const FallbackBlock = () => (
  <div
    data-tiptap-loading
    className="min-h-[64px] text-muted-foreground/40 text-sm"
  />
);

export type { TiptapEditorProps };

// We gate the editor mount on the vault path query resolving — see the
// comment in tiptap-editor-impl on why. The cached query is effectively
// instant after the first call (made by AppShell at startup), so the
// gate adds zero perceived latency in practice.
export function TiptapEditor(props: TiptapEditorProps) {
  const { isPending } = useVaultPath();
  if (isPending) {
    return <FallbackBlock />;
  }
  return (
    <Suspense fallback={<FallbackBlock />}>
      <TiptapEditorImpl {...props} />
    </Suspense>
  );
}
