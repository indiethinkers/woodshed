import { describe, expect, it } from "vitest";
import {
  addressAvatar,
  avatarColorForEmail,
  initialsForName,
  parseMailAddress,
} from "./avatars";

const PALETTE = new Set([
  "teal",
  "purple",
  "blue",
  "coral",
  "pink",
  "amber",
  "gray",
]);

describe("avatarColorForEmail", () => {
  it("is deterministic and case-insensitive", () => {
    expect(avatarColorForEmail("jordan@example.com")).toBe(
      avatarColorForEmail("Jordan@Example.COM"),
    );
    expect(avatarColorForEmail("a@b.com")).toBe(avatarColorForEmail("a@b.com"));
  });

  it("always lands on the palette", () => {
    for (const email of [
      "a@example.com",
      "b@example.com",
      "c@example.com",
      "d@example.com",
      "e@example.com",
      "f@example.com",
      "g@example.com",
    ]) {
      expect(PALETTE.has(avatarColorForEmail(email))).toBe(true);
    }
  });
});

describe("initialsForName", () => {
  it("uses up to two word initials", () => {
    expect(initialsForName("Avery Example", "avery@example.com")).toBe("AE");
    expect(initialsForName("Jordan", "jordan@example.com")).toBe("J");
  });

  it("falls back to the email local-part", () => {
    expect(initialsForName(null, "jordan.hoffman@example.com")).toBe("J");
    expect(initialsForName("", "no-reply@example.com")).toBe("N");
  });

  it("skips punctuation-only words", () => {
    expect(initialsForName("Acme, Inc.", "acme@example.com")).toBe("AI");
  });
});

describe("parseMailAddress", () => {
  it("splits a display name from an angle address", () => {
    expect(parseMailAddress("Jordan Hoffman <jordan@example.com>")).toEqual({
      name: "Jordan Hoffman",
      email: "jordan@example.com",
    });
    expect(parseMailAddress('"Quoted, Name" <q@example.com>')).toEqual({
      name: "Quoted, Name",
      email: "q@example.com",
    });
  });

  it("keeps bare emails and bare names intact", () => {
    expect(parseMailAddress("jordan@example.com")).toEqual({
      name: null,
      email: "jordan@example.com",
    });
    expect(parseMailAddress("Jordan")).toEqual({ name: "Jordan", email: "" });
  });
});

describe("addressAvatar", () => {
  it("derives initials and a stable tint from an address line", () => {
    const avatar = addressAvatar("Jordan Hoffman <jordan@example.com>");
    expect(avatar.initials).toBe("JH");
    expect(avatar.color).toBe(avatarColorForEmail("jordan@example.com"));
  });

  it("prefers an explicit email override for the tint", () => {
    const avatar = addressAvatar("Jordan", "jordan@example.com");
    expect(avatar.initials).toBe("J");
    expect(avatar.color).toBe(avatarColorForEmail("jordan@example.com"));
  });

  it("handles a bare email with no display name", () => {
    const avatar = addressAvatar("no-reply@example.com");
    expect(avatar.initials).toBe("N");
  });
});
