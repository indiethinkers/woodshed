import { describe, expect, it } from "vitest";
import { isLoopbackAgentUrl } from "./connection";

describe("isLoopbackAgentUrl", () => {
  it("recognizes only local loopback hosts", () => {
    expect(isLoopbackAgentUrl("http://127.0.0.1:8644/v1")).toBe(true);
    expect(isLoopbackAgentUrl("http://127.0.0.2:8644/v1")).toBe(true);
    expect(isLoopbackAgentUrl("http://localhost:8642/v1")).toBe(true);
    expect(isLoopbackAgentUrl("http://[::1]:8642/v1")).toBe(true);
    expect(isLoopbackAgentUrl("https://agent.example.com/v1")).toBe(false);
    expect(isLoopbackAgentUrl("http://localhost.example.com/v1")).toBe(false);
    expect(isLoopbackAgentUrl("http://127.example.com/v1")).toBe(false);
    expect(isLoopbackAgentUrl("not a URL")).toBe(false);
  });
});
