import { render, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";

const styles = readFileSync("src/styles.css", "utf8");

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/lib/hooks/use-today", () => ({
  useToday: () => "2026-07-09",
}));

vi.mock("@/lib/hooks/use-vault-path", () => ({
  useVaultPath: () => ({ data: "/tmp/vault", isPending: false }),
}));

vi.mock("@/lib/hooks/use-daily-journal", () => ({
  useDailyJournalMutation: () => ({ mutateAsync: mocks.save }),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isTauri: () => false,
    hasBackend: () => false,
    tauriInvoke: vi.fn(async () => null),
  };
});

vi.mock("@/components/shared/tiptap-editor", async () => {
  const actual = await import("@/components/shared/tiptap-editor-impl");
  return {
    TiptapEditor: actual.TiptapEditor,
  };
});

import { DailyContent } from "./daily-content";

const SETTLE_MS = 1300;

beforeAll(() => {
  const rect = {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  const rects = [rect] as unknown as DOMRectList;
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => rects,
    });
  }
  if (!Range.prototype.getBoundingClientRect) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => rect,
    });
  }
  if (!("getClientRects" in Text.prototype)) {
    Object.defineProperty(Text.prototype, "getClientRects", {
      configurable: true,
      value: () => rects,
    });
  }
});

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.save.mockReset();
  mocks.save.mockImplementation(
    async ({ date, body }: { date: string; body: string }) => ({
      date,
      path: `cadence/${date}.md`,
      body,
    }),
  );
});

function renderDailyContent(body: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  return render(
    <DailyContent date="2026-07-09" body={body} showInlineTasks={false} />,
    { wrapper: Wrapper },
  );
}

function topLevelListItems(container: HTMLElement): Element[] {
  const root = container.querySelector(".tiptap-content");
  const list = Array.from(root?.children ?? []).find(
    (child) => child.tagName === "UL",
  );
  return Array.from(list?.children ?? []).filter(
    (child) => child.tagName === "LI",
  );
}

function setDomCursorAfterText(root: HTMLElement, text: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = node.textContent ?? "";
    const index = value.indexOf(text);
    if (index >= 0) {
      const range = document.createRange();
      range.setStart(node, index + text.length);
      range.collapse(true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    node = walker.nextNode();
  }
  throw new Error(`Text node not found: ${text}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("DailyContent notes editor", () => {
  it("renders saved timestamps as quiet metadata in the left gutter", async () => {
    const { container } = renderDailyContent("- [09:30] A journal entry\n- ");

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
    });

    const timestamp = container.querySelector<HTMLElement>(
      "[data-daily-timestamp]",
    );
    expect(timestamp?.hidden).toBe(false);
    expect(timestamp?.getAttribute("data-time")).toBe("09:30");
    expect(container.querySelectorAll("[data-daily-timestamp]")).toHaveLength(1);
    expect(styles).toMatch(
      /\[data-daily-timestamp\]\s*\{[^}]*position:\s*absolute;[^}]*right:\s*calc\(100% \+ 0\.75rem\);[^}]*font-variant-numeric:\s*tabular-nums;/s,
    );
    expect(styles).toMatch(
      /\[data-daily-timestamp\]::before\s*\{[^}]*content:\s*attr\(data-time\);/s,
    );
  });

  it("keeps intentional lines above embeds visible without offsetting a fresh paste", () => {
    expect(styles).toContain(`.tiptap-content[data-daily-timestamps]
  li:has(> :is(div[data-tweet-id], div[data-youtube-resource]))
  > p:empty:not(
    :has(+ :is(div[data-tweet-id], div[data-youtube-resource]))
  ),
.tiptap-content[data-daily-timestamps]
  li:has(> :is(div[data-tweet-id], div[data-youtube-resource]))
  > p:has(> br.ProseMirror-trailingBreak:only-child):not(
    :has(+ :is(div[data-tweet-id], div[data-youtube-resource]))
  ) {
  display: block;
}`);
  });

  it("covers the sticky header inset so scrolled notes cannot bleed above it", async () => {
    const { container } = renderDailyContent("- [09:30] A journal entry");

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
    });

    const stickyHeader = container.querySelector(".sticky");
    const scrollShield = container.querySelector(
      "[data-cadence-scroll-shield]",
    );

    expect(stickyHeader?.classList.contains("top-4")).toBe(true);
    expect(scrollShield?.classList.contains("h-4")).toBe(true);
    expect(scrollShield?.classList.contains("bg-content")).toBe(true);
  });

  it("renders markdown list markers as list structure after prose", async () => {
    const body =
      "- [08:51] Projects for the August Release:\n- [08:52] - A\n- [08:52] B";
    const { container } = renderDailyContent(body);

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
    });

    expect(container.querySelector(".tiptap-content")?.textContent).not.toContain(
      "- A",
    );
    expect(
      Array.from(
        container.querySelectorAll(
          ".tiptap-content > ul > li:first-child > ul > li",
        ),
        (item) => item.textContent,
      ),
    ).toEqual(["A", "B"]);
  });

  it("keeps a prose row visually unbulleted when a list starts beneath it", async () => {
    const { container } = renderDailyContent(
      "- [08:51] Hello\n\n  - First list item",
    );

    await waitFor(() => {
      expect(
        container.querySelector(
          ".tiptap-content > ul > li:first-child > ul > li",
        ),
      ).toBeTruthy();
    });

    expect(
      container.querySelector(
        ".tiptap-content > ul > li:first-child > .outline-fold-toggle",
      ),
    ).toBeTruthy();
    expect(styles).toMatch(
      /\.tiptap-content\[data-daily-timestamps\]\s*>\s*ul\s*>\s*li\[data-has-children\]\s*>\s*\.outline-fold-toggle\s*\{[^}]*display:\s*none;/,
    );
  });

  it("omits the outer rail while keeping deeper list nesting", async () => {
    const { container } = renderDailyContent(
      "- [08:51] Parent row\n\n  - List item\n    - Nested A\n    - Nested B",
    );

    await waitFor(() => {
      expect(
        container.querySelector(
          ".tiptap-content > ul > li:first-child > ul > li:first-child > ul",
        ),
      ).toBeTruthy();
    });

    expect(styles).toContain(`.tiptap-content[data-daily-timestamps] > ul > li > ul::before,
.tiptap-content[data-daily-timestamps] > ul > li > ol::before {
  content: none;
}`);
  });

  it("nests a fresh cadence row when space completes its dash marker", async () => {
    const body =
      "- [08:51] Projects for the August Release:\n- [08:52] -";
    const { container } = renderDailyContent(body);

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    setDomCursorAfterText(editorEl, "-");
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(editorEl, { key: " " });

    await waitFor(() => {
      expect(
        container.querySelector(
          ".tiptap-content > ul > li:first-child > ul > li",
        ),
      ).toBeTruthy();
    });
    expect(editorEl.textContent).not.toContain("-");
  });

  it("keeps the cadence editor in outline mode after command-a then delete", async () => {
    const body = "- [09:30] Parent\n\n  - Child";
    const { container } = renderDailyContent(body);

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    fireEvent.keyDown(editorEl, { key: "a", metaKey: true });
    fireEvent.keyDown(editorEl, { key: "Delete" });

    await waitFor(() => {
      expect(topLevelListItems(container)).toHaveLength(1);
    });
    expect(container.querySelector("[data-daily-timestamp]")).toBeNull();
    expect(container.textContent).not.toContain("Parent");
    expect(container.textContent).not.toContain("Child");

    await sleep(SETTLE_MS);
    expect(mocks.save).toHaveBeenLastCalledWith({
      date: "2026-07-09",
      body: "- ",
      previousBody: body,
    });
  }, 20000);
});
