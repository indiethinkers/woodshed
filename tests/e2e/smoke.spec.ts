import { test, expect } from "@playwright/test";

// Phase 0 smoke test: app loads, renders something. Real e2e flows for
// Tasks (Phase 2) and Calendar (Phase 3) will run via tauri-driver later.
test("app shell loads at /", async ({ page }) => {
  await page.goto("/");
  // The Today view's date heading or the Sidebar are reliable presence signals.
  await expect(page.locator("aside").first()).toBeVisible({ timeout: 10_000 });
});
