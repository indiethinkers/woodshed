import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

import { resolveAvatarSrc } from "./avatar";

afterEach(() => {
  vi.unstubAllEnvs();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("resolveAvatarSrc", () => {
  it("rejects legacy bundled, remote, and inline sources", () => {
    expect(resolveAvatarSrc("/avatars/alex.jpg")).toBeNull();
    expect(resolveAvatarSrc("https://example.com/alex.jpg")).toBeNull();
    expect(resolveAvatarSrc("data:image/png;base64,abc")).toBeNull();
  });
});
