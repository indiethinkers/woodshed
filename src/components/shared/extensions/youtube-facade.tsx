import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { openExternalUrl } from "@/lib/open-external";

/// A native YouTube player shell shared by editable and read-only Markdown.
///
/// Uses YouTube's standard player directly. The page URL is supplied as the
/// widget referrer because native webviews do not consistently attach an HTTP
/// Referer header when the app itself uses a custom URL scheme.
export function YoutubeFacade({
  url,
  videoId,
  controls,
  controlsVisible = false,
}: {
  url: string;
  videoId: string;
  controls?: ReactNode;
  controlsVisible?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const embedUrl = new URL(`https://www.youtube.com/embed/${videoId}`);
  embedUrl.searchParams.set("rel", "0");
  embedUrl.searchParams.set("widget_referrer", window.location.href);

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
    <div className="group/youtube relative my-3 aspect-video w-full overflow-hidden rounded-md bg-black">
      <iframe
        src={embedUrl.toString()}
        title={`YouTube video ${videoId}`}
        loading="lazy"
        referrerPolicy="unsafe-url"
        className="absolute inset-0 h-full w-full"
        frameBorder={0}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
      <div
        className={`absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded-md border border-black/10 bg-white/90 p-0.5 text-zinc-700 shadow-sm backdrop-blur transition-opacity duration-150 group-hover/youtube:pointer-events-auto group-hover/youtube:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 ${
          controlsVisible
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
        contentEditable={false}
      >
        {controls}
        {controls && <span aria-hidden className="mx-0.5 h-4 w-px bg-black/10" />}
        <button
          type="button"
          aria-label={copied ? "Copied YouTube link" : "Copy YouTube link"}
          title={copied ? "Copied" : "Copy YouTube link"}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={copyUrl}
          className="inline-flex size-7 items-center justify-center rounded-[5px] transition-colors hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/20"
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
            void openUrl(event).catch(() => {
              console.error("Failed to open YouTube link");
            });
          }}
          className="inline-flex size-7 items-center justify-center rounded-[5px] transition-colors hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/20"
        >
          <ExternalLink className="size-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
