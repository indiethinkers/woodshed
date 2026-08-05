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
});
