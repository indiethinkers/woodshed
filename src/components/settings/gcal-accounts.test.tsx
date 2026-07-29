import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { openExternalUrl } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => {}),
}));

vi.mock("@/lib/open-external", () => ({ openExternalUrl }));
vi.mock("@/lib/hooks/use-gcal", () => ({
  useGcalAccounts: () => ({ data: [], isLoading: false, error: null }),
  useGcalAccountMutations: () => ({
    add: { isPending: false, mutateAsync: vi.fn() },
    update: { isPending: false, mutateAsync: vi.fn() },
    remove: { isPending: false, mutateAsync: vi.fn() },
  }),
  useGcalSyncOne: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

import { GcalAccountSection } from "./gcal-accounts";

describe("GcalAccountSection", () => {
  beforeEach(() => openExternalUrl.mockClear());

  it("uses readable help text and opens Google settings externally", () => {
    render(<GcalAccountSection />);
    fireEvent.click(screen.getByRole("button", { name: "Add calendar" }));

    const instructions = screen.getByText(/Secret address in iCal format/);
    expect(instructions).toHaveClass("text-[13px]");

    fireEvent.click(
      screen.getByRole("link", { name: /Open Google Calendar settings/ }),
    );
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://calendar.google.com/calendar/r/settings",
    );
  });
});
