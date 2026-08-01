import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface ReleaseMetadata {
  tag: string;
  packageVersion: string;
  tauriVersion: string;
  cargoVersion: string;
  changelog: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateReleaseMetadata({
  tag,
  packageVersion,
  tauriVersion,
  cargoVersion,
  changelog,
}: ReleaseMetadata): string[] {
  const errors: string[] = [];
  const versions = [packageVersion, tauriVersion, cargoVersion];

  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    errors.push(`Tag ${tag || "<missing>"} must use the vX.Y.Z format.`);
  }
  if (new Set(versions).size !== 1) {
    errors.push(
      `Version mismatch: package.json=${packageVersion}, tauri.conf.json=${tauriVersion}, Cargo.toml=${cargoVersion}.`,
    );
  }
  if (tag !== `v${packageVersion}`) {
    errors.push(`Tag ${tag || "<missing>"} does not match version ${packageVersion}.`);
  }

  const changelogHeading = new RegExp(
    `^## (?:\\[)?${escapeRegExp(packageVersion)}(?:\\])?(?:\\s|$)`,
    "m",
  );
  if (!changelogHeading.test(changelog)) {
    errors.push(`CHANGELOG.md has no section for ${packageVersion}.`);
  }

  return errors;
}

function readCargoVersion(source: string): string {
  const packageSection = source.match(
    /^\[package\]\s*([\s\S]*?)(?=\n\[|$)/,
  )?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error("Could not read the package version from Cargo.toml.");
  return version;
}

function main(): void {
  const tag = process.argv[2] ?? "";
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    version: string;
  };
  const tauriConfig = JSON.parse(
    readFileSync("src-tauri/tauri.conf.json", "utf8"),
  ) as { version: string };
  const cargoVersion = readCargoVersion(
    readFileSync("src-tauri/Cargo.toml", "utf8"),
  );

  const errors = validateReleaseMetadata({
    tag,
    packageVersion: packageJson.version,
    tauriVersion: tauriConfig.version,
    cargoVersion,
    changelog: readFileSync("CHANGELOG.md", "utf8"),
  });

  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Release metadata matches ${tag}.`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
