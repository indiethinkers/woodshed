import { describe, expect, it } from "vitest";
import { validateReleaseMetadata } from "../../scripts/check-release";

const validRelease = {
  tag: "v1.2.3",
  packageVersion: "1.2.3",
  tauriVersion: "1.2.3",
  cargoVersion: "1.2.3",
  changelog: "# Changelog\n\n## 1.2.3\n\n- Synthetic release note.\n",
};

describe("validateReleaseMetadata", () => {
  it("accepts a synchronized release", () => {
    expect(validateReleaseMetadata(validRelease)).toEqual([]);
  });

  it("rejects mismatched versions and tags", () => {
    expect(
      validateReleaseMetadata({
        ...validRelease,
        tag: "release-1.2.3",
        cargoVersion: "1.2.2",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vX.Y.Z"),
        expect.stringContaining("Version mismatch"),
        expect.stringContaining("does not match"),
      ]),
    );
  });

  it("requires a changelog section for the release", () => {
    expect(
      validateReleaseMetadata({ ...validRelease, changelog: "## Unreleased\n" }),
    ).toContain("CHANGELOG.md has no section for 1.2.3.");
  });
});
