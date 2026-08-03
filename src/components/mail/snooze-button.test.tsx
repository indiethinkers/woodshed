import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snoozeOne: vi.fn(async () => {}),
}));

vi.mock("@/lib/hooks/use-mail", () => ({
  useSnoozeOne: () => mocks.snoozeOne,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { SnoozeButton } from "./snooze-button";

describe("SnoozeButton", () => {
  beforeEach(() => {
    mocks.snoozeOne.mockClear();
  });

  it("snoozes every message in a thread until the chosen custom time", async () => {
    render(<SnoozeButton messageIds={["message-1", "message-2"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    fireEvent.change(screen.getByLabelText("Custom date and time"), {
      target: { value: "2031-02-05T09:30" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Snooze until selected time" }),
    );

    const expected = new Date("2031-02-05T09:30").toISOString();
    await waitFor(() => expect(mocks.snoozeOne).toHaveBeenCalledTimes(2));
    expect(mocks.snoozeOne).toHaveBeenCalledWith("message-1", expected);
    expect(mocks.snoozeOne).toHaveBeenCalledWith("message-2", expected);
  });
});
