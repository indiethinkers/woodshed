// Regression coverage for the 2026-06-10 daily-journal wipe: a YouTube URL
// captured as a `- [HH:MM] <url>` bullet was converted into an embed node
// the list item couldn't legally host, ProseMirror's slice-fitter mangled
// the list (timestamp destroyed, bullet emptied), and the editor's autosave
// rewrote the whole file from the mangled doc. These tests pin down the two
// fixes: (1) the URL→embed transform only fires where the embed is
// schema-legal, and (2) loading or ingesting a file never produces a commit.
import { beforeAll, describe, it, expect, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isTauri: () => false,
    hasBackend: () => false,
    tauriInvoke: vi.fn(async () => null),
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("@/lib/hooks/use-vault-path", () => ({
  useVaultPath: () => ({ data: "/tmp/vault", isPending: false }),
}));

import { TiptapEditor } from "./tiptap-editor-impl";
import { stripEmptyTimestampBulletsFromMarkdown } from "@/lib/daily-timestamps";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Longer than EMBED_TRANSFORM_DELAY_MS (300) + BODY_AUTOSAVE_DELAY_MS (750),
// so a buggy dirty-on-load would have committed by the time we assert.
const SETTLE_MS = 1300;

const BULLET_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const BLOCK_URL = "https://www.youtube.com/watch?v=XWpTgCvgYaE";

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

const BODY = `- [08:08] First note of the day with real content.
- [11:45] Second note, also load-bearing.
- [14:14] ${BULLET_URL}

#resource #youtube

${BLOCK_URL}

- [14:29] Trailing note after the embed block.
`;

function mountEditor(onCommit: (next: string) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (value: string) => (
    <QueryClientProvider client={qc}>
      <TiptapEditor
        value={value}
        onCommit={onCommit}
        mode="freeform"
        timestampedListItems
        placeholder="Start writing..."
      />
    </QueryClientProvider>
  );
  return { ui, ...render(ui(BODY)) };
}

function mountOutlineEditor(value: string, onCommit: (next: string) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (nextValue: string) => (
    <QueryClientProvider client={qc}>
      <TiptapEditor
        value={nextValue}
        onCommit={onCommit}
        mode="outline"
        timestampedListItems
        placeholder="Start writing..."
      />
    </QueryClientProvider>
  );
  return { ui, ...render(ui(value)) };
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

function nestedListItems(container: HTMLElement, topLevelIndex = 0): Element[] {
  const topItem = topLevelListItems(container)[topLevelIndex];
  const nestedList = Array.from(topItem?.children ?? []).find(
    (child) => child.tagName === "UL",
  );
  return Array.from(nestedList?.children ?? []).filter(
    (child) => child.tagName === "LI",
  );
}

function setDomCursorAtText(
  root: HTMLElement,
  text: string,
  placement: "start" | "end",
) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = node.textContent ?? "";
    const index = value.indexOf(text);
    if (index >= 0) {
      const range = document.createRange();
      range.setStart(node, index + (placement === "end" ? text.length : 0));
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

function setDomCursorAfterText(root: HTMLElement, text: string) {
  setDomCursorAtText(root, text, "end");
}

function setDomCursorBeforeText(root: HTMLElement, text: string) {
  setDomCursorAtText(root, text, "start");
}

function setDomCursorInside(element: Element) {
  const target = element.querySelector("p") ?? element;
  const range = document.createRange();
  range.setStart(target, 0);
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("TiptapEditor URL embeds (daily journal)", () => {
  it("keeps rich clipboard structure instead of flattening it to plain text", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <TiptapEditor value="" onCommit={vi.fn()} mode="freeform" />
      </QueryClientProvider>,
    );
    const editorEl = await waitFor(() => {
      const root = container.querySelector<HTMLElement>(".tiptap-content");
      expect(root).toBeTruthy();
      return root!;
    });
    editorEl.focus();

    fireEvent.paste(editorEl, {
      clipboardData: {
        items: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return "<h2>Release notes</h2><p><strong>Keep this emphasis.</strong></p><ul><li>One</li><li>Two</li></ul>";
          }
          return "Release notes\nKeep this emphasis.\nOne\nTwo";
        },
      },
    });

    await waitFor(() => {
      expect(editorEl.querySelector("h2")).toHaveTextContent("Release notes");
      expect(editorEl.querySelector("strong")).toHaveTextContent("Keep this emphasis.");
      expect(editorEl.querySelectorAll("li")).toHaveLength(2);
    });
  });

  it("loads a journal without mangling bullets or committing anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    const commits: string[] = [];
    const { container } = mountEditor((next) => commits.push(next));

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
    });
    await sleep(SETTLE_MS);

    // Loading a file is not an edit: nothing may be written back.
    expect(commits).toEqual([]);

    // The URL inside the timestamped bullet stays plain text — converting
    // it would destroy the bullet (listItem can't host a block atom first).
    expect(container.textContent).toContain(BULLET_URL);

    // The top-level `#resource #youtube` + URL block still converts.
    expect(
      container.querySelectorAll("[data-youtube-resource], iframe").length,
    ).toBeGreaterThan(0);
    expect(container.textContent).not.toContain(BLOCK_URL);

    // All four capture timestamps survive.
    const stamps = Array.from(
      container.querySelectorAll("[data-daily-timestamp]"),
    ).map((el) => el.getAttribute("data-time"));
    expect(stamps).toEqual(
      expect.arrayContaining(["08:08", "11:45", "14:14", "14:29"]),
    );

    // The other bullets are intact.
    expect(container.textContent).toContain("First note of the day");
    expect(container.textContent).toContain("Trailing note after the embed");
  }, 20000);

  it("ingests an external append without committing or losing content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    const commits: string[] = [];
    const { ui, container, rerender } = mountEditor((next) =>
      commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
    });
    await sleep(SETTLE_MS);

    // Simulate a read-modify-write append flowing back in as the new external
    // value while this editor is open.
    const appended =
      BODY.trimEnd() + "\n- [14:31] A second note right after the URL.\n";
    rerender(ui(appended));
    await sleep(SETTLE_MS);

    expect(commits).toEqual([]);
    expect(container.textContent).toContain(
      "A second note right after the URL.",
    );
    expect(container.textContent).toContain("First note of the day");
    expect(container.textContent).toContain(BULLET_URL);
  }, 20000);

  it("deletes a YouTube embed from the editor control", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    const commits: string[] = [];
    const { container } = mountEditor((next) => commits.push(next));

    await waitFor(() => {
      expect(
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Delete YouTube embed"]',
        ),
      ).toBeTruthy();
    });

    const deleteButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete YouTube embed"]',
    );
    expect(deleteButton).toBeTruthy();
    fireEvent.mouseDown(deleteButton!);
    fireEvent.click(deleteButton!);

    await waitFor(() => {
      expect(container.querySelector("[data-youtube-resource]")).toBeNull();
    });
    await sleep(SETTLE_MS);

    expect(commits.at(-1)).not.toContain(BLOCK_URL);
    expect(commits.at(-1)).toContain(BULLET_URL);
  }, 20000);

  it("does not ingest an external value while the editor has unsaved local edits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    const commits: string[] = [];
    const { ui, container, rerender } = mountEditor((next) =>
      commits.push(next),
    );

    await waitFor(() => {
      expect(
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Delete YouTube embed"]',
        ),
      ).toBeTruthy();
    });

    const deleteButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete YouTube embed"]',
    );
    fireEvent.mouseDown(deleteButton!);
    fireEvent.click(deleteButton!);

    await waitFor(() => {
      expect(container.querySelector("[data-youtube-resource]")).toBeNull();
    });

    const externalAppend =
      BODY.trimEnd() + "\n- [14:31] External append while dirty.\n";
    rerender(ui(externalAppend));
    await sleep(SETTLE_MS);

    expect(container.querySelector("[data-youtube-resource]")).toBeNull();
    expect(container.textContent).not.toContain("External append while dirty.");
    expect(commits.at(-1)).not.toContain(BLOCK_URL);
    expect(commits.at(-1)).not.toContain("External append while dirty.");
    expect(commits.at(-1)).toContain(BULLET_URL);
  }, 20000);
});

describe("TiptapEditor outline save echo", () => {
  it("keeps a focused empty timestamp row when the saved body echoes back stripped", async () => {
    const withWorkingRow = "- [09:30] Hello,\n\n  - Nested\n\n- [09:31] ";
    const stripped = stripEmptyTimestampBulletsFromMarkdown(withWorkingRow);
    const commits: string[] = [];
    const { ui, container, rerender } = mountOutlineEditor(
      withWorkingRow,
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
      expect(topLevelListItems(container)).toHaveLength(2);
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);

    rerender(ui(stripped));

    await waitFor(() => {
      expect(topLevelListItems(container)).toHaveLength(2);
    });
    expect(commits).toEqual([]);
  });

  it("selects the full editor body on command-a", async () => {
    const commits: string[] = [];
    const { container } = mountOutlineEditor(
      "- [09:30] Parent\n\n  - Child",
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    fireEvent.keyDown(editorEl, { key: "a", metaKey: true });

    const selected = document.getSelection()?.toString() ?? "";
    expect(selected).toContain("Parent");
    expect(selected).toContain("Child");
    expect(commits).toEqual([]);
  }, 20000);

  it("keeps an editable outline row after command-a then delete", async () => {
    const commits: string[] = [];
    const { container } = mountOutlineEditor(
      "- [09:30] Parent\n\n  - Child",
      (next) => commits.push(next),
    );

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
    expect(commits).toEqual([]);
  }, 20000);

  it("clears only the current outline row on command-delete", async () => {
    const commits: string[] = [];
    const child = "a nested line with multiple words";
    const { container } = mountOutlineEditor(
      `- [09:30] This is another test\n\n  - ${child}`,
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
      expect(container.textContent).toContain(child);
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    setDomCursorAfterText(editorEl, child);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(editorEl, { key: "Backspace", metaKey: true });

    await waitFor(() => {
      expect(container.textContent).toContain("This is another test");
      expect(container.textContent).not.toContain(child);
    });
    expect(commits).toEqual([]);
  }, 20000);

  it("removes an empty parent row without deleting its children", async () => {
    const commits: string[] = [];
    const child = "Child";
    const { container } = mountOutlineEditor(
      `- [09:30] Parent\n\n  - ${child}`,
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
      expect(container.textContent).toContain("Parent");
      expect(container.textContent).toContain(child);
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    setDomCursorAfterText(editorEl, "Parent");
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(editorEl, { key: "Backspace", metaKey: true });
    fireEvent.keyDown(editorEl, { key: "Delete" });

    await waitFor(() => {
      const items = topLevelListItems(container);
      expect(items).toHaveLength(1);
      expect(items[0]?.textContent).toContain(child);
      expect(container.textContent).not.toContain("Parent");
    });
    expect(commits).toEqual([]);
  }, 20000);

  it("indents a top-level row on tab through the mounted editor", async () => {
    const commits: string[] = [];
    const child = "Child";
    const { container } = mountOutlineEditor(
      `- [09:30] Parent\n- [09:31] ${child}`,
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
      expect(topLevelListItems(container)).toHaveLength(2);
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    setDomCursorAfterText(editorEl, child);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(editorEl, { key: "Tab" });

    await waitFor(() => {
      expect(topLevelListItems(container)).toHaveLength(1);
      const nested = nestedListItems(container);
      expect(nested).toHaveLength(1);
      expect(nested[0]?.textContent).toContain(child);
    });
    expect(commits).toEqual([]);
  }, 20000);

  it("outdents a nested row on shift-tab through the mounted editor", async () => {
    const commits: string[] = [];
    const child = "Child";
    const { container } = mountOutlineEditor(
      `- [09:30] Parent\n\n  - ${child}`,
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
      expect(nestedListItems(container)).toHaveLength(1);
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    setDomCursorAfterText(editorEl, child);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(editorEl, { key: "Tab", shiftKey: true });

    await waitFor(() => {
      const items = topLevelListItems(container);
      expect(items).toHaveLength(2);
      expect(items[1]?.textContent).toContain(child);
      expect(nestedListItems(container)).toHaveLength(0);
    });
    expect(commits).toEqual([]);
  }, 20000);

  it("outdents an empty nested row on shift-tab without deleting it", async () => {
    const commits: string[] = [];
    const child = "Nested";
    const { container } = mountOutlineEditor(
      `- [09:30] Hello\n\n  - ${child}`,
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
      expect(nestedListItems(container)).toHaveLength(1);
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    setDomCursorAfterText(editorEl, child);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(editorEl, { key: "Enter" });
    fireEvent.keyDown(editorEl, { key: "Tab", shiftKey: true });

    await waitFor(() => {
      const items = topLevelListItems(container);
      expect(items).toHaveLength(2);
      expect(items[0]?.textContent).toContain("Hello");
      expect(nestedListItems(container)).toHaveLength(1);
      expect(nestedListItems(container)[0]?.textContent).toContain(child);
    });
    expect(commits).toEqual([]);
  }, 20000);

  it("removes a nested bullet after command-delete clears its text", async () => {
    const commits: string[] = [];
    const child = "Nested";
    const { container } = mountOutlineEditor(
      `- [09:30] Parent\n\n  - ${child}`,
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
      expect(nestedListItems(container)).toHaveLength(1);
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    setDomCursorAfterText(editorEl, child);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(editorEl, { key: "Backspace", metaKey: true });

    await waitFor(() => {
      expect(container.textContent).toContain("Parent");
      expect(container.textContent).not.toContain(child);
      expect(nestedListItems(container)).toHaveLength(1);
    });

    fireEvent.keyDown(editorEl, { key: "Delete" });

    await waitFor(() => {
      expect(topLevelListItems(container)).toHaveLength(1);
      expect(nestedListItems(container)).toHaveLength(0);
      expect(container.textContent).toContain("Parent");
    });
    expect(commits).toEqual([]);
  }, 20000);

  it("removes an already-empty nested bullet on command-delete", async () => {
    const commits: string[] = [];
    const { container } = mountOutlineEditor(
      "- [09:30] Parent\n\n  - ",
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
      expect(nestedListItems(container)).toHaveLength(1);
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    setDomCursorInside(nestedListItems(container)[0]!);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(editorEl, { key: "Backspace", metaKey: true });

    await waitFor(() => {
      expect(topLevelListItems(container)).toHaveLength(1);
      expect(nestedListItems(container)).toHaveLength(0);
      expect(container.textContent).toContain("Parent");
    });
    expect(commits).toEqual([]);
  }, 20000);

  it("pastes multiple paragraphs as timestamped top-level outline rows", async () => {
    const commits: string[] = [];
    const { container } = mountOutlineEditor(
      "- ",
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    fireEvent.paste(editorEl, {
      clipboardData: {
        items: [],
        getData: (type: string) =>
          type === "text/plain"
            ? "First pasted thought.\n\nSecond pasted thought."
            : "",
      },
    });

    await sleep(SETTLE_MS);

    expect(topLevelListItems(container)).toHaveLength(2);
    expect(container.textContent).toContain("First pasted thought.");
    expect(container.textContent).toContain("Second pasted thought.");
    expect(commits.at(-1)).toMatch(
      /^- \[\d{2}:\d{2}\] First pasted thought\.\n- \[\d{2}:\d{2}\] Second pasted thought\.$/,
    );
  }, 20000);

  it("outdents an empty nested row on enter", async () => {
    const commits: string[] = [];
    const child = "Nested";
    const { container } = mountOutlineEditor(
      `- [09:30] Hello\n\n  - ${child}`,
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
      expect(container.textContent).toContain(child);
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    setDomCursorAfterText(editorEl, child);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(editorEl, { key: "Enter" });
    fireEvent.keyDown(editorEl, { key: "Enter" });

    await waitFor(() => {
      expect(topLevelListItems(container)).toHaveLength(2);
    });
    expect(commits).toEqual([]);
  }, 20000);

  it("outdents a nested row on backspace at the start of its text", async () => {
    const commits: string[] = [];
    const child = "Nested";
    const { container } = mountOutlineEditor(
      `- [09:30] Hello\n\n  - ${child}`,
      (next) => commits.push(next),
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-content")).toBeTruthy();
      expect(container.textContent).toContain(child);
    });

    const editorEl = container.querySelector<HTMLElement>(".tiptap-content")!;
    editorEl.focus();
    fireEvent.focus(editorEl);
    setDomCursorBeforeText(editorEl, child);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(editorEl, { key: "Backspace" });

    await waitFor(() => {
      const items = topLevelListItems(container);
      expect(items).toHaveLength(2);
      expect(items[1]?.textContent).toContain(child);
    });
    expect(commits).toEqual([]);
  }, 20000);
});
