import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
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

import { TiptapEditor } from "./tiptap-editor-impl";

async function unmountAndDrainEditorTimers(unmount: () => void) {
  unmount();
  // Tiptap defers editor destruction, and ProseMirror schedules a final
  // DOMObserver flush 20 ms later. Let both finish while jsdom still exists.
  await new Promise((resolve) => setTimeout(resolve, 25));
}

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
