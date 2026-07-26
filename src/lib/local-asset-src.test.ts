import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

import { resolveLocalAssetSrc } from "./local-asset-src";

afterEach(() => {
  vi.unstubAllEnvs();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("resolveLocalAssetSrc", () => {
  it("uses the Tauri asset protocol inside Tauri", () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    expect(resolveLocalAssetSrc("/Users/me/woodshed/attachments/avatar.jpg")).toBe(
      "asset:///Users/me/woodshed/attachments/avatar.jpg",
    );
  });

  it("returns null for local files in plain browser mode", () => {
    expect(resolveLocalAssetSrc("/Users/me/woodshed/attachments/avatar.jpg")).toBeNull();
  });

  it("passes non-local values through", () => {
    expect(resolveLocalAssetSrc("attachments/avatar.jpg")).toBe("attachments/avatar.jpg");
  });
});
