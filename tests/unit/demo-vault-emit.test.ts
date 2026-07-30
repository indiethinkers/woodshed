import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VaultWriter } from "../../scripts/demo-vault/emit";

describe("VaultWriter", () => {
  it("rejects em dashes in generated demo records", () => {
    const root = mkdtempSync(join(tmpdir(), "woodshed-demo-writer-"));
    const writer = new VaultWriter(root);

    expect(() =>
      writer.write("notebook/example.md", "Before — after\n"),
    ).toThrow(/em dash/);
  });
});
