import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useCompactTextareaCaret } from "./textarea-compact-caret";

function Harness({ lineHeight }: { lineHeight?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useCompactTextareaCaret(ref);
  return (
    <div className="relative">
      <textarea
        ref={ref}
        defaultValue="flawless precision."
        style={{ fontSize: "14px", ...(lineHeight ? { lineHeight } : {}) }}
      />
    </div>
  );
}

function frame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function giveLayout(textarea: HTMLTextAreaElement | HTMLElement) {
  // jsdom reports zero geometry; give the visibility check real bounds.
  Object.defineProperty(textarea, "clientHeight", {
    value: 40,
    configurable: true,
  });
  Object.defineProperty(textarea, "clientWidth", {
    value: 300,
    configurable: true,
  });
}

describe("useCompactTextareaCaret", () => {
  it("hides the native caret and draws a font-sized overlay caret on focus", async () => {
    const { unmount } = render(<Harness lineHeight="20px" />);
    const textarea = screen.getByRole("textbox");
    const wrapper = textarea.parentElement as HTMLElement;

    // The native caret is suppressed and the overlay exists but is
    // display:none until the textarea is focused.
    expect(textarea.style.caretColor).toBe("transparent");
    const caret = wrapper.querySelector(".ws-textarea-caret");
    expect(caret).not.toBeNull();
    expect(caret).toHaveAttribute("aria-hidden", "true");
    expect((caret as HTMLElement).style.display).toBe("none");

    // Focus moves the caret into the editing position. jsdom reports zero
    // geometry, so the marker sits at the padding-box origin and the caret
    // is centered on the line: (20px line - 14px font) / 2 = 3px.
    giveLayout(textarea);
    textarea.focus();
    await frame();

    expect((caret as HTMLElement).style.display).toBe("block");
    expect((caret as HTMLElement).style.height).toBe("14px");
    expect((caret as HTMLElement).style.transform).toBe(
      "translate3d(0px, 3px, 0)",
    );
    // The mirror keeps no residual text after measuring.
    expect(wrapper.querySelector(".ws-textarea-caret-mirror")?.textContent).toBe(
      "",
    );

    // Blur hides the overlay again.
    fireEvent.blur(textarea);
    expect((caret as HTMLElement).style.display).toBe("none");

    // Cleanup removes the mirror + caret and restores the native caret.
    unmount();
    expect(wrapper.querySelector(".ws-textarea-caret")).toBeNull();
    expect(wrapper.querySelector(".ws-textarea-caret-mirror")).toBeNull();
    expect(textarea.style.caretColor).toBe("");
  });

  it("still shows the caret when line-height computes to `normal`", async () => {
    // `line-height: normal` parses to NaN; the visibility check must fall
    // back to the font size instead of permanently hiding the caret.
    render(<Harness />);
    const textarea = screen.getByRole("textbox");
    giveLayout(textarea);
    textarea.focus();
    await frame();

    const caret = textarea.parentElement?.querySelector(
      ".ws-textarea-caret",
    ) as HTMLElement;
    expect(caret.style.display).toBe("block");
    expect(caret.style.transform).toBe("translate3d(0px, 0px, 0)");
  });

  it("shrinks the mirror by the scrollbar width so wrapped lines stay aligned", async () => {
    render(<Harness lineHeight="20px" />);
    const textarea = screen.getByRole("textbox");
    giveLayout(textarea);
    // A scrollbar that consumes layout width makes the textarea's content
    // box narrower than clientWidth; the mirror must match that narrower
    // wrap width or caret coordinates drift on wrapped lines.
    Object.defineProperty(textarea, "offsetWidth", {
      value: 315,
      configurable: true,
    });
    textarea.focus();
    await frame();

    const mirror = textarea.parentElement?.querySelector(
      ".ws-textarea-caret-mirror",
    ) as HTMLElement;
    // clientWidth 300 − 15px scrollbar = 285.
    expect(mirror.style.width).toBe("285px");
  });

  it("never leaves the mirror font empty when the computed font serializes empty", async () => {
    // WKWebView can return "" for getComputedStyle().font (seen on the
    // mail/agent composers); an empty `font:` declaration is dropped and
    // the mirror falls back to its UA monospace, which renders ~20% wider
    // and pushes the caret several characters right of the insertion
    // point. The mirror font must come from longhands with an `inherit`
    // fallback — never empty. (jsdom's computed font is likewise empty.)
    render(<Harness lineHeight="20px" />);
    const textarea = screen.getByRole("textbox");
    const mirror = textarea.parentElement?.querySelector(
      ".ws-textarea-caret-mirror",
    ) as HTMLElement;

    // The mirror's font family/size/line-height must always be populated
    // from longhands (with an `inherit` fallback) — never left at the UA
    // default that an empty `font:` shorthand would produce.
    expect(mirror.style.fontFamily).not.toBe("");
    expect(mirror.style.fontSize).not.toBe("");
    expect(mirror.style.lineHeight).not.toBe("");
  });
});
