import { describe, expect, it } from "vitest";
import {
  extractEmailRecipients,
  forwardSubject,
  parseSweepPersonCommand,
} from "./action-command";

describe("sweep action command helpers", () => {
  it("detects person/contact update commands", () => {
    expect(parseSweepPersonCommand("update the person record")).toBe(true);
    expect(parseSweepPersonCommand("add this to contact notes")).toBe(true);
    expect(parseSweepPersonCommand("create a task for tomorrow")).toBe(false);
  });

  it("extracts unique email recipients from freeform targets", () => {
    expect(
      extractEmailRecipients(
        "Forward to Alex <ALEX@example.com>, ops@example.com and alex@example.com",
      ),
    ).toEqual(["alex@example.com", "ops@example.com"]);
  });

  it("normalizes forward subjects without double-prefixing", () => {
    expect(forwardSubject("Launch notes")).toBe("Fwd: Launch notes");
    expect(forwardSubject("Fwd: Launch notes")).toBe("Fwd: Launch notes");
  });
});
