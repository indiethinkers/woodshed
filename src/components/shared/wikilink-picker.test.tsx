import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WikilinkPicker } from "./wikilink-picker";

vi.mock("@/lib/hooks/use-search", () => ({
  useSearch: () => ({
    data: [
      {
        docId: "harrison",
        title: "Harrison",
        hint: "Person",
        kind: "person",
      },
    ],
  }),
}));

vi.mock("@/lib/hooks/use-notes", () => ({
  useNoteMutations: () => ({ create: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/lib/hooks/use-people", () => ({
  usePeopleMutations: () => ({ create: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/lib/hooks/use-areas", () => ({
  useAreas: () => ({ data: [] }),
}));

describe("WikilinkPicker", () => {
  it("opens above a caret near the bottom of the viewport", async () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
      200,
    );

    render(
      <WikilinkPicker
        state={{
          query: "Harrison",
          command: vi.fn(),
          clientRect: () =>
            ({
              top: 560,
              bottom: 580,
              left: 300,
              right: 301,
              width: 1,
              height: 20,
              x: 300,
              y: 560,
              toJSON: () => ({}),
            }) as DOMRect,
        }}
      />,
    );

    const picker = await screen.findByText("Match for “Harrison”");
    const popup = picker.closest("[data-wikilink-picker]");
    expect(popup).toHaveStyle({ top: "354px", left: "300px" });
  });
});
