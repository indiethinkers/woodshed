import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isTauri, tauriInvoke } from "@/lib/tauri";
import { openExternalUrl } from "@/lib/open-external";

interface HtmlBodyProps {
  /**
   * Message id. Doubles as the URL key for the rendered body
   * (`wsmail://localhost/body/<id>`) and the height cache key.
   */
  messageId: string;
}

// Heights live in a module-scoped Map (so they survive component
// mounts within a session) plus a localStorage mirror (so they survive
// app restarts and dev-server reloads). The first ever open of an
// email pays a small grow-or-shrink cost from `DEFAULT_HEIGHT` to the
// real measurement; every subsequent open of that email — across any
// session — lands at the right size with no visible shift.
const HEIGHT_CACHE_LIMIT = 200;
const HEIGHT_STORAGE_KEY = "woodshed:email-heights:v1";
// First-time fallback before we've measured an email. Roughly the
// median rendered height for the newsletters we see, which keeps the
// initial-render delta small either way (long emails grow, short
// emails shrink). Beats the previous 120px stub which made every
// fresh-open visibly *expand* into place.
const DEFAULT_HEIGHT = 600;

function loadHeightCache(): Map<string, number> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const out = new Map<string, number>();
    for (const entry of parsed) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1])
      ) {
        out.set(entry[0], entry[1]);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

const HEIGHT_CACHE = loadHeightCache();

let persistTimer: number | null = null;
function schedulePersist() {
  if (typeof window === "undefined") return;
  if (persistTimer !== null) return;
  // Debounced so a flurry of ResizeObserver-driven height updates
  // during the lazy-image cascade only writes localStorage once.
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    try {
      window.localStorage.setItem(
        HEIGHT_STORAGE_KEY,
        JSON.stringify(Array.from(HEIGHT_CACHE.entries())),
      );
    } catch {
      // Storage full, disabled, or quota exceeded — best-effort, ignore.
    }
  }, 500);
}

function rememberHeight(key: string, height: number) {
  if (HEIGHT_CACHE.has(key)) HEIGHT_CACHE.delete(key);
  HEIGHT_CACHE.set(key, height);
  if (HEIGHT_CACHE.size > HEIGHT_CACHE_LIMIT) {
    const oldest = HEIGHT_CACHE.keys().next().value;
    if (oldest !== undefined) HEIGHT_CACHE.delete(oldest);
  }
  schedulePersist();
}

/**
 * Email body iframe.
 *
 * The rendered HTML — sanitized, image-rewritten, wrapped with our
 * styles and an inline bridge script — is generated in Rust by
 * `email_render::render_email` and served via the wsmail:// `/body/`
 * URI scheme. We prime the cache via `email_body_render` before
 * pointing the iframe at the URL, so the iframe `src` always resolves
 * to a populated cache entry.
 *
 * The bridge runs inside the iframe (`sandbox="allow-scripts"`):
 *   - intercepts link clicks, postMessages the href to the parent
 *   - preventDefault on `mousedown` for anchors so focus stays in the
 *     parent and Esc / j / k keep working
 *   - reports content size via ResizeObserver → postMessage
 *
 * The parent — this component — does nothing inside the iframe. It
 * only listens for postMessages, dispatches link opens through the
 * Tauri shell, and resizes the iframe element to reported heights.
 */
export function HtmlBody({ messageId }: HtmlBodyProps) {
  // Key on `messageId` so the inner instance gets a fresh `useState`
  // initializer per email — that's how we pick up the right cached
  // height on every navigation without a setState-in-effect dance to
  // reset state from the previous email.
  return <HtmlBodyInner key={messageId} messageId={messageId} />;
}

function HtmlBodyInner({ messageId }: HtmlBodyProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(
    () => HEIGHT_CACHE.get(messageId) ?? DEFAULT_HEIGHT,
  );

  // Prime the rendered-body cache, then point the iframe at it.
  // TanStack Query owns the lifecycle so the "while a new messageId is
  // rendering, src reverts to null and the iframe blanks" behavior
  // falls out without setState-in-effect.
  const { data: rendered } = useQuery({
    queryKey: ["email-body-render", messageId, "remote-images"],
    enabled: isTauri(),
    staleTime: Infinity,
    queryFn: async () => {
      const result = await tauriInvoke<{
        cacheId: string;
        hasRemoteImages: boolean;
      }>("email_body_render", { id: messageId, loadRemoteImages: true });
      if (!result) throw new Error("Email body renderer returned no result");
      return {
        ...result,
        src: `wsmail://localhost/body/${encodeURIComponent(result.cacheId)}`,
      };
    },
  });

  // Listen for the iframe bridge's postMessages.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Drop messages that aren't from our iframe (defends against any
      // other window posting at us). srcDoc/sandbox iframes have a
      // "null" origin string, so we filter by source identity rather
      // than origin.
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;
      const data = e.data as
        | {
            type?: string;
            href?: unknown;
            height?: unknown;
            deltaX?: unknown;
            deltaY?: unknown;
          }
        | undefined;
      if (!data || typeof data !== "object") return;

      if (data.type === "wsmail-link" && typeof data.href === "string") {
        const href = data.href;
        if (!href || href.startsWith("#")) return;
        if (!isTauri()) return;
        openExternalUrl(href).catch((err) => {
          console.error("Failed to open email link", href, err);
        });
      } else if (
        data.type === "wsmail-height" &&
        typeof data.height === "number" &&
        Number.isFinite(data.height)
      ) {
        const next = Math.round(data.height);
        setHeight((prev) => (prev === next ? prev : next));
        rememberHeight(messageId, next);
      } else if (
        data.type === "wsmail-wheel" &&
        typeof data.deltaY === "number" &&
        Number.isFinite(data.deltaY)
      ) {
        // The email iframe is auto-height and never scrolls internally, so
        // the bridge forwards wheels here. Scroll the page's own scroll
        // container — this is the same container EmailDetail resets on mount.
        const viewport = iframe.closest(
          '[data-woodshed-content-scroll], [data-slot="scroll-area-viewport"]',
        );
        if (!(viewport instanceof HTMLElement)) return;
        // Release ContentPanel's late-load scroll guard: it only sees wheel
        // events on the parent window, so without this it would snap the
        // forwarded scroll back to the top during the settle window.
        window.dispatchEvent(
          new WheelEvent("wheel", { deltaY: data.deltaY, bubbles: true }),
        );
        viewport.scrollTop += data.deltaY;
        if (
          typeof data.deltaX === "number" &&
          Number.isFinite(data.deltaX) &&
          data.deltaX !== 0
        ) {
          viewport.scrollLeft += data.deltaX;
        }
      } else if (data.type === "wsmail-interaction") {
        // A user interaction happened inside the email (e.g. the
        // "Show trimmed content" toggle). The click lives in the
        // sandboxed iframe so it never reaches EmailDetail's
        // pointerdown listener; forward it as a pointerdown on the
        // iframe element so the thread's auto-follow disengages and
        // the height change doesn't yank the view back to the newest
        // message.
        iframe.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true }),
        );
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [messageId]);

  return (
    <div>
      <iframe
      ref={iframeRef}
      // `allow-scripts` lets the bridge inside the iframe run; we omit
      // `allow-same-origin` so the iframe gets an opaque origin
      // (cross-origin isolation as a hard fallback if the Rust
      // sanitizer ever lets something through). No `allow-popups`
      // either — the bridge dispatches navigation via postMessage,
      // never via `window.open`.
      sandbox="allow-scripts"
      src={rendered?.src ?? "about:blank"}
      title="Email body"
      style={{
        width: "100%",
        height: `${height}px`,
        border: "0",
        // The rendered document paints its own light canvas (sender colours
        // assume one), so match it here rather than leaving the frame
        // transparent — otherwise the app's dark background shows through for
        // the frame we spend loading and the email flashes in.
        background: "#ffffff",
      }}
      />
    </div>
  );
}
