import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { openExternalUrl } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => {}),
}));

vi.mock("@/lib/open-external", () => ({ openExternalUrl }));

import { ExternalAnchor } from "./external-link";

describe("ExternalAnchor", () => {
  it("routes clicks through the native external URL boundary", () => {
    render(
      <ExternalAnchor href="https://example.test/help">Open help</ExternalAnchor>,
    );

    const link = screen.getByRole("link", { name: "Open help" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.test/help");
  });

  it("preserves a consumer click handler", () => {
    const onClick = vi.fn();
    render(
      <ExternalAnchor href="https://example.test/help" onClick={onClick}>
        Open help
      </ExternalAnchor>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open help" }));

    expect(onClick).toHaveBeenCalledOnce();
  });
});
