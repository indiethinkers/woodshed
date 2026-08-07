import { afterEach, describe, expect, it, vi } from "vitest";

describe("supportsViewTransition", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("returns false when the View Transition API is unavailable", async () => {
    vi.stubGlobal("document", { startViewTransition: undefined });
    const { supportsViewTransition } = await import("./view-transition");
    expect(supportsViewTransition()).toBe(false);
  });

  it("returns false on Linux Tauri even when the API exists", async () => {
    vi.stubGlobal("document", { startViewTransition: vi.fn() });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64) WebKit/537.36" });
    const { supportsViewTransition } = await import("./view-transition");
    expect(supportsViewTransition()).toBe(false);
  });

  it("returns true on macOS Tauri when the API exists", async () => {
    vi.stubGlobal("document", { startViewTransition: vi.fn() });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15",
    });
    const { supportsViewTransition } = await import("./view-transition");
    expect(supportsViewTransition()).toBe(true);
  });
});
