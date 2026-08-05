import { useEffect, type RefObject } from "react";

/**
 * WebKit sizes the native textarea caret to the current line box, so
 * prose with generous leading shows a caret much taller than the glyphs
 * (Twitter keeps its caret near font size). This hook mirrors the
 * Tiptap `CompactCaret` approach for plain `<textarea>`s: hide the
 * native caret and draw a font-sized overlay caret at the selection.
 *
 * The overlay caret is positioned with the classic mirror technique: a
 * hidden, identically-styled `<pre>` copies the text up to the caret
 * plus a marker span; the marker's offset gives the caret coordinates.
 * The mirror/caret are appended to the textarea's parent (which the
 * hook makes `position: relative` if needed), so any layout works.
 *
 * Usage:
 *   const ref = useRef<HTMLTextAreaElement>(null);
 *   useCompactTextareaCaret(ref);
 *   return <textarea ref={ref} ... />;
 */
export function useCompactTextareaCaret(
  ref: RefObject<HTMLTextAreaElement | null>,
): void {
  useEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    const parent = textarea.parentElement;
    if (!parent) return;

    const computed = getComputedStyle(textarea);
    const fontSize = parseFloat(computed.fontSize);
    const lineHeight = parseFloat(computed.lineHeight);
    const centerOffset = Number.isFinite(lineHeight)
      ? (lineHeight - fontSize) / 2
      : 0;
    // Defensive parse: computed border widths can come back empty in some
    // environments (jsdom), which parseFloat turns into NaN.
    const px = (value: string) => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };
    const borderLeft = px(computed.borderLeftWidth);
    const borderTop = px(computed.borderTopWidth);
    const borderRight = px(computed.borderRightWidth);
    const parentComputed = getComputedStyle(parent);
    const parentBorderLeft = px(parentComputed.borderLeftWidth);
    const parentBorderTop = px(parentComputed.borderTopWidth);

    // Absolute positioning inside the parent; make the parent positioned
    // when it isn't already so the mirror/caret anchor to it.
    const previousPosition = parent.style.position;
    if (parentComputed.position === "static") {
      parent.style.position = "relative";
    }

    // Mirror: same font, padding, and wrap width so text wraps exactly
    // like the textarea.
    const mirror = document.createElement("pre");
    mirror.className = "ws-textarea-caret-mirror";
    mirror.setAttribute("aria-hidden", "true");
    const pad = (side: string) => computed.getPropertyValue(`padding-${side}`);
    mirror.style.cssText = [
      "position:absolute",
      "top:0",
      "left:0",
      `width:${textarea.clientWidth}px`,
      "height:auto",
      "box-sizing:border-box",
      "margin:0",
      "visibility:hidden",
      "pointer-events:none",
      "white-space:pre-wrap",
      `overflow-wrap:${computed.overflowWrap}`,
      `word-break:${computed.wordBreak}`,
      // WebKit's getComputedStyle().font can serialize to an EMPTY string
      // (observed in WKWebView for the mail/agent composers). An empty
      // `font:` declaration is dropped, leaving the mirror at its UA
      // defaults — 16px monospace — so the mirror's text renders ~20%
      // wider than the textarea and the caret lands several characters to
      // the right of the true insertion point. Build the font from
      // longhands instead, falling back to `inherit` so the mirror picks
      // up the same font the textarea renders when it inherits one.
      `font-family:${computed.fontFamily || "inherit"}`,
      `font-size:${computed.fontSize || "inherit"}`,
      `font-weight:${computed.fontWeight || "inherit"}`,
      `font-style:${computed.fontStyle || "inherit"}`,
      `line-height:${computed.lineHeight || "inherit"}`,
      `letter-spacing:${computed.letterSpacing}`,
      `word-spacing:${computed.wordSpacing}`,
      `tab-size:${computed.tabSize}`,
      `text-indent:${computed.textIndent}`,
      `padding:${pad("top")} ${pad("right")} ${pad("bottom")} ${pad("left")}`,
    ].join(";");

    // Overlay caret: 1.5px stem, font-sized, blinking at the clock cadence.
    // Hidden (display:none — the `hidden` attribute would be defeated by the
    // author `display:block` rule) until the textarea actually has focus.
    const caret = document.createElement("span");
    caret.className = "ws-textarea-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.style.display = "none";
    caret.style.height = `${fontSize}px`;

    parent.appendChild(mirror);
    parent.appendChild(caret);

    let raf = 0;
    let disposed = false;

    const measure = () => {
      raf = 0;
      // Keep the mirror's wrap width current (window resize / parent layout
      // changes) so wrapped-line caret coordinates stay aligned. When a
      // scrollbar consumes content width (legacy scrollbars), the textarea
      // wraps earlier than the mirror would — shrink the mirror by the
      // scrollbar width so the wrap points match exactly.
      const scrollbarWidth = Math.max(
        0,
        textarea.offsetWidth - textarea.clientWidth - borderLeft - borderRight,
      );
      mirror.style.width = `${Math.max(0, textarea.clientWidth - scrollbarWidth)}px`;
      if (disposed || document.activeElement !== textarea) return;
      const caretPos = textarea.selectionEnd ?? textarea.selectionStart ?? 0;
      mirror.textContent = textarea.value.slice(0, caretPos);
      const marker = document.createElement("span");
      marker.textContent = textarea.value.slice(caretPos) || ".";
      mirror.appendChild(marker);

      // The mirror sits at the textarea's padding-box origin within the
      // parent (viewport-rect delta so padding anywhere in the chain can't
      // shift it). Subtract the parent's own border: the containing block
      // for absolutely positioned children starts at the padding edge.
      const textareaRect = textarea.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const originLeft =
        textareaRect.left - parentRect.left - parentBorderLeft + borderLeft;
      const originTop =
        textareaRect.top - parentRect.top - parentBorderTop + borderTop;

      const left = originLeft + marker.offsetLeft - textarea.scrollLeft;
      const top =
        originTop + marker.offsetTop - textarea.scrollTop + centerOffset;

      // `line-height: normal` parses to NaN; fall back to the font size so
      // the visibility check can never short-circuit to "hidden".
      const lineBox = Number.isFinite(lineHeight) ? lineHeight : fontSize;
      const visible =
        marker.offsetTop + lineBox > textarea.scrollTop &&
        marker.offsetTop < textarea.scrollTop + textarea.clientHeight &&
        marker.offsetLeft >= textarea.scrollLeft &&
        marker.offsetLeft < textarea.scrollLeft + textarea.clientWidth;

      const transform = `translate3d(${left}px, ${top}px, 0)`;
      caret.style.transform = transform;
      caret.style.display = visible ? "block" : "none";
      mirror.textContent = "";
    };

    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    const hideCaret = () => {
      caret.style.display = "none";
      mirror.textContent = "";
    };

    // Hide the native caret only while this hook owns the rendering; the
    // overlay replaces it, so the caret never disappears entirely.
    textarea.style.caretColor = "transparent";
    textarea.addEventListener("input", schedule);
    textarea.addEventListener("keyup", schedule);
    textarea.addEventListener("click", schedule);
    textarea.addEventListener("scroll", schedule);
    textarea.addEventListener("focus", schedule);
    textarea.addEventListener("blur", hideCaret);
    textarea.addEventListener("compositionstart", hideCaret);
    textarea.addEventListener("compositionend", schedule);
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("resize", schedule);
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(schedule)
        : null;
    observer?.observe(parent);

    schedule();

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      parent.style.position = previousPosition;
      textarea.style.caretColor = "";
      textarea.removeEventListener("input", schedule);
      textarea.removeEventListener("keyup", schedule);
      textarea.removeEventListener("click", schedule);
      textarea.removeEventListener("scroll", schedule);
      textarea.removeEventListener("focus", schedule);
      textarea.removeEventListener("blur", hideCaret);
      textarea.removeEventListener("compositionstart", hideCaret);
      textarea.removeEventListener("compositionend", schedule);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      mirror.remove();
      caret.remove();
    };
    // The hook wires a single textarea for its lifetime; callers remount
    // the textarea (or key it) when the target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
