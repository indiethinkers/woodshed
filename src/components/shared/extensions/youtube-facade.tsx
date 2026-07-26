import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Play } from "lucide-react";
import { openExternalUrl } from "@/lib/open-external";

/// Shared click-to-load YouTube facade. It makes no request to YouTube until
/// the user hits play, at which point the privacy-enhanced player iframe is
/// created.
///
/// No surrounding card chrome (title / tag pills) — the video stands on its
/// own, in both the Tiptap editor (`YoutubeResourceView`) and the read-only
/// `Markdown` renderer (sidebar / mail).
export function YoutubeFacade({
  url,
  videoId,
}: {
  url: string;
  videoId: string;
}) {
  const [playing, setPlaying] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(id);
  }, [copied]);

  async function copyUrl(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard support can vary in WKWebView/browser contexts; the
      // original URL remains available through the open action.
    }
  }

  async function openUrl(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    await openExternalUrl(url);
  }

  return (
    <div className="group/youtube relative my-3 aspect-video w-full overflow-hidden rounded-md bg-black first:mt-0 last:mb-0">
      <div
        className="absolute right-2 top-2 z-20 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/youtube:opacity-100 focus-within:opacity-100"
        contentEditable={false}
      >
        <button
          type="button"
          aria-label={copied ? "Copied YouTube link" : "Copy YouTube link"}
          title={copied ? "Copied" : "Copy YouTube link"}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={copyUrl}
          className="inline-flex size-7 items-center justify-center rounded-md border border-white/15 bg-black/70 text-white/90 backdrop-blur transition-colors hover:bg-black/85 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          {copied ? (
            <Check className="size-3.5" strokeWidth={2.2} />
          ) : (
            <Copy className="size-3.5" strokeWidth={2} />
          )}
        </button>
        <button
          type="button"
          aria-label="Open YouTube link"
          title="Open YouTube link"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            void openUrl(event).catch((error) => {
              console.error("Failed to open YouTube link", url, error);
            });
          }}
          className="inline-flex size-7 items-center justify-center rounded-md border border-white/15 bg-black/70 text-white/90 backdrop-blur transition-colors hover:bg-black/85 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <ExternalLink className="size-3.5" strokeWidth={2} />
        </button>
      </div>
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
          className="absolute inset-0 h-full w-full"
          frameBorder={0}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          aria-label="Play video"
          // stopPropagation so the click toggles play rather than letting
          // ProseMirror turn it into an atom-node selection.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setPlaying(true)}
          className="group absolute inset-0 h-full w-full cursor-pointer"
        >
          <span
            aria-hidden
            className="absolute left-1/2 top-1/2 flex h-[44px] w-[64px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-xl bg-black/60 shadow-lg transition-colors duration-150 group-hover:bg-[#ff0000]"
          >
            <Play className="h-5 w-5 translate-x-px fill-white text-white" />
          </span>
        </button>
      )}
    </div>
  );
}
