import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemeToRoot,
  clearSystemThemeWatcher,
  setThemePreference,
} from "./theme";

describe("applyThemeToRoot", () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    clearSystemThemeWatcher();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    clearSystemThemeWatcher();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("adds .dark on documentElement when theme is dark", () => {
    applyThemeToRoot("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("removes .dark when theme is light", () => {
    document.documentElement.classList.add("dark");
    applyThemeToRoot("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("follows prefers-color-scheme when theme is system", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => fakeMatcher(true),
    });
    applyThemeToRoot("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => fakeMatcher(false),
    });
    applyThemeToRoot("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});

describe("setThemePreference", () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    clearSystemThemeWatcher();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    clearSystemThemeWatcher();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("updates the root when the system color scheme changes", () => {
    const media = fakeMatcher(false);
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => media,
    });

    setThemePreference("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    media.setMatches(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");

    media.setMatches(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("stops listening when the user chooses an explicit theme", () => {
    const media = fakeMatcher(true);
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => media,
    });

    setThemePreference("system");
    expect(media.listenerCount()).toBe(1);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    setThemePreference("light");
    expect(media.listenerCount()).toBe(0);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    media.setMatches(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

type TestMediaQueryList = MediaQueryList & {
  setMatches(next: boolean): void;
  listenerCount(): number;
};

function fakeMatcher(initialMatches: boolean): TestMediaQueryList {
  let matches = initialMatches;
  const listeners = new Set<() => void>();

  return {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: vi.fn((listener: () => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: () => void) => {
      listeners.delete(listener);
    }),
    addEventListener: vi.fn((_type: string, listener: () => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => {
      listeners.delete(listener);
    }),
    dispatchEvent: vi.fn(),
    setMatches(next: boolean) {
      matches = next;
      listeners.forEach((listener) => listener());
    },
    listenerCount() {
      return listeners.size;
    },
  } as unknown as TestMediaQueryList;
}
