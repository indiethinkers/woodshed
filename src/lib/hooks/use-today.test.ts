import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useToday } from "./use-today";

describe("useToday", () => {
  it("returns a YYYY-MM-DD string", () => {
    const { result } = renderHook(() => useToday());
    expect(result.current).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches the local date", () => {
    const { result } = renderHook(() => useToday());
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(result.current).toBe(expected);
  });
});
