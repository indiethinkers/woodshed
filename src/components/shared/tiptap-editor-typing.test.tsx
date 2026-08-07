import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
  useSearch: () => ({ data: [] }),
}));

import { TiptapEditor } from "./tiptap-editor-impl";

async function unmountAndDrainEditorTimers(unmount: () => void) {
  unmount();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("TiptapEditor typing stability", () => {
  it("keeps typed apostrophes as straight quotes", async () => {
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
            view: {
              dispatch: (tr: unknown) => void;
              state: { tr: { insertText: (text: string) => unknown } };
            };
            getText: () => string;
          };
        }
      >(".tiptap-content");
      expect(element?.editor).toBeTruthy();
      return element!;
    });

    act(() => {
      const editor = content.editor!;
      editor.view.dispatch(editor.view.state.tr.insertText("don"));
      editor.view.dispatch(editor.view.state.tr.insertText("'"));
    });

    await waitFor(() => {
      expect(content.editor!.getText()).toBe("don'");
    });
    expect(content.editor!.getText()).not.toContain("\u2019");
    expect(content.textContent).not.toContain("\u2019");

    await unmountAndDrainEditorTimers(unmount);
  });

  it("suppresses OS smart substitution attrs on the contenteditable", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container, unmount } = render(
      <QueryClientProvider client={queryClient}>
        <TiptapEditor value="" onCommit={vi.fn()} />
      </QueryClientProvider>,
    );

    const content = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(".tiptap-content");
      expect(element).toBeTruthy();
      return element!;
    });

    expect(content.getAttribute("autocorrect")).toBe("off");
    expect(content.getAttribute("autocomplete")).toBe("off");
    expect(content.getAttribute("spellcheck")).toBe("false");

    await unmountAndDrainEditorTimers(unmount);
  });
});
