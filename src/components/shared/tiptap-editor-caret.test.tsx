import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const styles = readFileSync("src/styles.css", "utf8");

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

vi.mock("@/lib/hooks/use-search", () => ({
  useSearch: () => ({
    data: [
      {
        docId: "project-note",
        title: "Project",
        hint: "Note",
        kind: "note",
      },
    ],
  }),
}));

import { TiptapEditor } from "./tiptap-editor-impl";

async function unmountAndDrainEditorTimers(unmount: () => void) {
  unmount();
  // Tiptap defers editor destruction, and ProseMirror schedules a final
  // DOMObserver flush 20 ms later. Let both finish while jsdom still exists.
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("TiptapEditor image rows", () => {
  it("keeps a bare image row as one list item with a stable markdown roundtrip", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const VALUE =
      "- [13:50] Sarah and Bowen was a sight to behold. Pure joy.\n" +
      "- ![IMG_2744.HEIC](attachments/01KZ9V59JKGHPN52Q4ZTDRWBA7.heic)\n";
    const { container, unmount } = render(
      <QueryClientProvider client={queryClient}>
        <TiptapEditor
          value={VALUE}
          onCommit={vi.fn()}
          mode="outline"
          timestampedListItems
        />
      </QueryClientProvider>,
    );

    const content = await waitFor(() => {
      const element = container.querySelector<
        HTMLElement & {
          editor?: {
            getJSON: () => unknown;
            storage?: { markdown?: { getMarkdown?: () => string } };
          };
        }
      >(".tiptap-content");
      expect(element?.editor).toBeTruthy();
      return element!;
    });

    // A bare image row must parse as a SINGLE list item holding the image —
    // not as an empty item followed by an image item (the empty item
    // rendered as a gap above the image and the roundtrip wrote a `- ` row
    // back to the file, pushing the image down on every commit).
    const json = content.editor!.getJSON() as {
      content?: {
        content?: { content?: { type: string }[] }[];
      }[];
    };
    const items = json.content?.[0]?.content ?? [];
    expect(items.length).toBe(2);
    expect(items[1].content?.[0]?.type).toBe("image");

    // The markdown roundtrip must not introduce an empty row above the image.
    const roundtrip =
      content.editor!.storage?.markdown?.getMarkdown?.() ?? "";
    expect(roundtrip + "\n").toBe(VALUE);
    expect(roundtrip).not.toContain("\n- \n");

    await unmountAndDrainEditorTimers(unmount);
  });
});

describe("TiptapEditor slash command", () => {
  it("commits the selected command on Enter in timestamped mode instead of splitting a new row", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container, unmount } = render(
      <QueryClientProvider client={queryClient}>
        <TiptapEditor
          value=""
          onCommit={vi.fn()}
          mode="outline"
          timestampedListItems
        />
      </QueryClientProvider>,
    );

    const content = await waitFor(() => {
      const element = container.querySelector<
        HTMLElement & {
          editor?: {
            commands: { insertContent: (value: string) => void };
            getJSON: () => unknown;
          };
        }
      >(".tiptap-content");
      expect(element?.editor).toBeTruthy();
      return element!;
    });

    // Type "/" to open the slash menu (the Suggestion plugin activates
    // when the trigger char lands), then "he" to filter the items — the
    // same two keystrokes a user types.
    act(() => {
      content.editor!.commands.insertContent("/");
    });

    await waitFor(() => {
      expect(document.querySelector("[data-slash-command-menu]")).toBeTruthy();
    });

    act(() => {
      content.editor!.commands.insertContent("he");
    });

    await waitFor(() => {
      expect(
        document.querySelectorAll("[data-slash-command-menu] button").length,
      ).toBeGreaterThan(0);
    });

    // Enter must run the highlighted command — the timestamped-list
    // Enter handler used to split a new row before the suggestion
    // plugin's keymap ever saw the key.
    fireEvent.keyDown(content, { key: "Enter" });

    await waitFor(() => {
      const json = JSON.stringify(content.editor!.getJSON());
      expect(json).not.toContain("/he");
    });

    const jsonText = JSON.stringify(content.editor!.getJSON());
    expect(jsonText).toContain("\"type\":\"heading\"");
    expect(jsonText).toContain("\"level\":1");

    await unmountAndDrainEditorTimers(unmount);
  });
});

describe("TiptapEditor caret cadence", () => {
  it("installs Woodshed's controlled caret instead of relying on WebKit timing", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container, unmount } = render(
      <QueryClientProvider client={queryClient}>
        <TiptapEditor value="A note" onCommit={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-compact-caret")).toBeTruthy();
    });

    await unmountAndDrainEditorTimers(unmount);
  });

  it("survives React's development remount cycle", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container, unmount } = render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <TiptapEditor value="A note" onCommit={vi.fn()} />
        </QueryClientProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap-compact-caret")).toBeTruthy();
    });

    await unmountAndDrainEditorTimers(unmount);
  });

  it("ignores an external value update while the previous editor is destroyed", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = (value: string) => (
      <QueryClientProvider client={queryClient}>
        <TiptapEditor value={value} onCommit={vi.fn()} />
      </QueryClientProvider>
    );
    const { container, rerender, unmount } = render(ui("First value"));

    const content = await waitFor(() => {
      const element = container.querySelector<
        HTMLElement & { editor?: { destroy: () => void } }
      >(".tiptap-content");
      expect(element?.editor).toBeTruthy();
      return element!;
    });

    content.editor!.destroy();

    expect(() => rerender(ui("Second value"))).not.toThrow();

    await unmountAndDrainEditorTimers(unmount);
  });

  it("opens record search when the user types @", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container, unmount } = render(
      <QueryClientProvider client={queryClient}>
        <TiptapEditor value="" onCommit={vi.fn()} />
      </QueryClientProvider>,
    );

    const content = await waitFor(() => {
      const element = container.querySelector<
        HTMLElement & {
          editor?: {
            commands: { insertContent: (value: string) => void };
            getJSON: () => unknown;
          };
        }
      >(".tiptap-content");
      expect(element?.editor).toBeTruthy();
      return element!;
    });

    act(() => {
      content.editor!.commands.insertContent("@Project");
    });

    await waitFor(() => {
      expect(document.querySelector("[data-wikilink-picker]")).toBeTruthy();
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /^Project\s*Note$/i }),
    );

    await waitFor(() => {
      expect(JSON.stringify(content.editor!.getJSON())).toContain(
        '"type":"wikilink","attrs":{"text":"Project"',
      );
    });

    await unmountAndDrainEditorTimers(unmount);
  });

  it("does not treat an email address as a record search", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container, unmount } = render(
      <QueryClientProvider client={queryClient}>
        <TiptapEditor value="" onCommit={vi.fn()} />
      </QueryClientProvider>,
    );

    const content = await waitFor(() => {
      const element = container.querySelector<
        HTMLElement & {
          editor?: { commands: { insertContent: (value: string) => void } };
        }
      >(".tiptap-content");
      expect(element?.editor).toBeTruthy();
      return element!;
    });

    act(() => {
      content.editor!.commands.insertContent("person@example.test");
    });

    expect(document.querySelector("[data-wikilink-picker]")).toBeNull();

    await unmountAndDrainEditorTimers(unmount);
  });

  it("uses equal visible and hidden halves with no startup bias", () => {
    const caretRule = styles.match(/\.tiptap-compact-caret\s*\{([^}]*)\}/)?.[1];

    expect(caretRule).toContain(
      "animation: tiptap-compact-caret-blink 1s step-end infinite",
    );
    expect(caretRule).not.toContain("min-height");
    expect(caretRule).not.toContain("animation-delay");
    expect(styles).toMatch(
      /@keyframes tiptap-compact-caret-blink\s*\{[\s\S]*?50%,\s*100%\s*\{\s*opacity:\s*0;/,
    );
  });
});
