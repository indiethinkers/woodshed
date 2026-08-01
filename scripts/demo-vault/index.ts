// Demo vault generator.
//
// Writes a complete, coherent Woodshed vault dated relative to a single anchor
// ("demo day"), for showing the product to investors and accelerators. The
// output is a standalone vault directory. `--clock-out` can additionally write
// a vault-scoped clock into app data for a stable presentation.
//
//   bun run demo:vault -- --out ~/woodshed-demo
//   bun run demo:vault -- --out ~/woodshed-demo --date 2026-08-14
//   bun run demo:vault -- --out ~/woodshed-demo \
//     --clock-out <app_data_dir>/demo-clock.json
//   bun run demo:vault -- --out ~/woodshed-demo --force
//
// All people, companies and addresses in `content/` are invented and use
// `.example` domains. No value from a real vault, mailbox or contact list
// belongs in this directory (see AGENTS.md → Private-data hygiene).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { Calendar } from "./dates";
import { VaultWriter } from "./emit";
import { buildAreas } from "./content/areas";
import { buildPeople } from "./content/people";
import { buildNotebook } from "./content/notebook";
import { buildResources } from "./content/resources";
import { buildCadence } from "./content/cadence";
import { buildTables } from "./content/tables";
import { buildMail } from "./content/mail";
import { buildAgent } from "./content/agent";

/**
 * Mirrors `VAULT_SUBDIRS` in `src-tauri/src/vault/mod.rs:46`, plus `archive`,
 * which the indexer reads (`index/mod.rs:569`) but `ensure_dirs` does not
 * create.
 */
const VAULT_SUBDIRS = [
  "tasks",
  "cadence",
  "events",
  "people",
  "inbox",
  "sent",
  "archive",
  "drafts",
  "notebook",
  "resources",
  "areas",
  "agent",
  "tables",
  "data",
  "attachments",
] as const;

interface Options {
  out: string;
  date: string;
  force: boolean;
  clockOut?: string;
}

const DEFAULT_DEMO_DATE = "2026-10-12";
const DEMO_TIME = "13:15";

function usage(): string {
  return [
    "Usage: bun run demo:vault -- --out <path> [--date YYYY-MM-DD] [--clock-out <path>] [--force]",
    "",
    "  --out <path>     Directory to write the vault into (required).",
    `  --date <date>    Anchor date for 'today'. Defaults to ${DEFAULT_DEMO_DATE}.`,
    "  --clock-out      Write app-data demo-clock.json for stable visual state.",
    "  --force          Write into a non-empty directory.",
  ].join("\n");
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

function parseArgs(argv: readonly string[]): Options {
  let out: string | undefined;
  let date: string | undefined;
  let clockOut: string | undefined;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--out":
      case "--date":
      case "--clock-out": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`${arg} requires a value`);
        }
        if (arg === "--out") out = value;
        else if (arg === "--date") date = value;
        else clockOut = value;
        i += 1;
        break;
      }
      case "--force":
        force = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (out === undefined) throw new Error("--out is required");
  const expanded = expandHome(out);
  const expandedClockOut =
    clockOut === undefined ? undefined : expandHome(clockOut);
  return {
    out: isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded),
    date: date ?? DEFAULT_DEMO_DATE,
    force,
    clockOut:
      expandedClockOut === undefined
        ? undefined
        : isAbsolute(expandedClockOut)
          ? expandedClockOut
          : resolve(process.cwd(), expandedClockOut),
  };
}

function assertWritable(dir: string, force: boolean): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir).filter((name) => !name.startsWith("."));
  if (entries.length === 0 || force) return;
  throw new Error(
    `${dir} is not empty (${entries.length} entries). Re-run with --force to write into it anyway.`,
  );
}

function writeDemoClock(path: string, vaultPath: string, now: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ vaultPath, now }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tempPath, path);
}

function main(): void {
  let options: Options;
  let calendar: Calendar;
  try {
    options = parseArgs(process.argv.slice(2));
    // Inside the guard: an impossible --date (2026-02-31) is user error and
    // deserves the usage text, not a stack trace.
    calendar = new Calendar(options.date);
    assertWritable(options.out, options.force);
  } catch (error) {
    console.error(`error: ${(error as Error).message}\n`);
    console.error(usage());
    process.exit(1);
    return;
  }

  for (const sub of VAULT_SUBDIRS) {
    mkdirSync(resolve(options.out, sub), { recursive: true });
  }

  const writer = new VaultWriter(options.out);
  const areas = buildAreas(writer, calendar);
  const people = buildPeople(writer, calendar);
  buildNotebook(writer, calendar);
  buildResources(writer, calendar);
  buildCadence(writer, calendar, people);
  buildTables(writer, calendar);
  const inboxCount = buildMail(writer, calendar);
  buildAgent(writer, calendar);
  if (options.clockOut !== undefined) {
    writeDemoClock(options.clockOut, options.out, calendar.at(0, DEMO_TIME));
  }

  const width = Math.max(
    ...writer.tally().map(([bucket]) => bucket.length),
    "total".length,
  );
  console.log(`Demo vault written to ${options.out}`);
  console.log(`Anchor date (demo "today"): ${calendar.anchor}\n`);
  for (const [bucket, count] of writer.tally()) {
    console.log(`  ${bucket.padEnd(width)}  ${String(count).padStart(4)}`);
  }
  console.log(
    `  ${"total".padEnd(width)}  ${String(writer.total()).padStart(4)}`,
  );
  console.log(
    `\n${areas.length} areas · ${people.length} people · ${inboxCount} inbox messages`,
  );
  console.log(
    "\nPoint Woodshed at this directory. If you go through onboarding," +
      '\nUNCHECK "Seed with sample content". It would mix stale sample' +
      "\nrecords into the dataset.",
  );
  if (options.clockOut !== undefined) {
    console.log("\nStable demo clock configured in app data.");
  }
}

main();
