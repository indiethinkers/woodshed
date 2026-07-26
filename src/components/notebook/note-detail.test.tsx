import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDto } from "@/lib/hooks/use-notes";

const mocks = vi.hoisted(() => {
  const makeNote = (id: string, title: string, body: string): NoteDto => ({
    id,
    path: `notebook/${id}.md`,
    revision: `rev-${id}`,
    title,
    area: "woodshed",
    created: "2026-06-21T08:10:11.893169-07:00",
    tags: [],
    favorite: false,
    body,
  });

  return {
    activeNote: makeNote("alpha", "Alpha", "Body alpha"),
    makeNote,
    mounts: [] as string[],
    unmounts: [] as string[],
    navigate: vi.fn(),
    update: { mutate: vi.fn(), mutateAsync: vi.fn() },
    remove: { mutate: vi.fn() },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/lib/hooks/use-areas", () => ({
  useAreas: () => ({
    data: [{ id: "woodshed", name: "Woodshed" }],
  }),
}));

vi.mock("@/lib/hooks/use-notes", () => ({
  useNote: () => ({ data: mocks.activeNote, isLoading: false }),
  useNoteMutations: () => ({ update: mocks.update, remove: mocks.remove }),
}));

vi.mock("@/components/shared/tiptap-editor", async () => {
  const React = await import("react");
  return {
    TiptapEditor: ({ value }: { value: string }) => {
      React.useEffect(() => {
        mocks.mounts.push(value);
        return () => {
          mocks.unmounts.push(value);
        };
      }, []);
      return React.createElement("div", { "data-testid": "editor" }, value);
    },
  };
});

vi.mock("@/components/shared/file-path-pill", () => ({
  FilePathLine: () => <div data-testid="path" />,
}));

vi.mock("@/components/shared/favorite-toggle", () => ({
  FavoriteToggle: () => <button type="button">Favorite</button>,
}));

vi.mock("@/components/shared/tag-editor", () => ({
  TagEditor: () => <div data-testid="tags" />,
}));

vi.mock("@/components/shared/property-list", () => ({
  PickerPropertyValue: () => <div data-testid="area" />,
  PropertyList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PropertyRow: ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { NoteDetail } from "./note-detail";

beforeEach(() => {
  mocks.activeNote = mocks.makeNote("alpha", "Alpha", "Body alpha");
  mocks.mounts.length = 0;
  mocks.unmounts.length = 0;
  mocks.navigate.mockClear();
  mocks.update.mutate.mockClear();
  mocks.update.mutateAsync.mockClear();
  mocks.remove.mutate.mockClear();
});

describe("NoteDetail", () => {
  it("remounts editor state when switching between notebook records", () => {
    const { rerender } = render(<NoteDetail id="alpha" />);

    expect(screen.getByTestId("editor")).toHaveTextContent("Body alpha");
    expect(mocks.mounts).toEqual(["Body alpha"]);

    mocks.activeNote = mocks.makeNote("beta", "Beta", "Body beta");
    rerender(<NoteDetail id="beta" />);

    expect(screen.getByTestId("editor")).toHaveTextContent("Body beta");
    expect(mocks.mounts).toEqual(["Body alpha", "Body beta"]);
    expect(mocks.unmounts).toEqual(["Body alpha"]);
  });
});
