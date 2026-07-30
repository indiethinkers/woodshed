// Minimal YAML emitter for demo-vault frontmatter.
//
// This does not aim to reproduce serde_yaml's output byte for byte. The
// contract the generated files have to meet is weaker and more useful: every
// file must *parse* through the Rust parsers in `src-tauri/src/parsers/`, and
// re-serializing what parsed must yield the same struct. The roundtrip test in
// `src-tauri/tests/demo_vault_roundtrip.rs` enforces exactly that.
//
// So the rule here is "emit unambiguous YAML", not "guess what serde would
// have written". Scalars are quoted whenever a plain scalar could be reread as
// something other than a string.

export interface YamlMap {
  [key: string]: YamlValue | undefined;
}

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | YamlMap;

/** YAML plain scalars that would reparse as a non-string type. */
const RESERVED_PLAIN = new Set([
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "null",
  "nil",
  "~",
  "",
]);

/** Control characters and newlines cannot appear in a plain YAML scalar. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when `value` can be written without quotes and still read back as the
 * identical string. Conservative on purpose: a false negative only costs a
 * pair of quotes, a false positive silently changes a record's data.
 */
function isPlainSafe(value: string): boolean {
  if (RESERVED_PLAIN.has(value.toLowerCase())) return false;
  if (value !== value.trim()) return false;
  // Anything numeric-looking (including dates like 2026-10-12, which YAML 1.1
  // parsers may coerce to a timestamp) gets quoted.
  if (/^[-+]?(\d|\.\d)/.test(value)) return false;
  // Indicators that open a non-scalar node or a comment when unquoted.
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return false;
  if (/:(\s|$)/.test(value)) return false;
  if (/\s#/.test(value)) return false;
  // Control chars and newlines cannot appear in a plain scalar.
  if (hasControlChar(value)) return false;
  return true;
}

/**
 * A double-quoted YAML scalar. YAML's double-quoted style shares JSON's escape
 * vocabulary, so JSON.stringify produces a valid and correctly escaped
 * scalar for every input, newlines and quotes included.
 */
export function quote(value: string): string {
  return JSON.stringify(value);
}

export function scalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot serialize non-finite number: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  return isPlainSafe(value) ? value : quote(value);
}

function isRecord(value: YamlValue): value is YamlMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitValue(value: YamlValue, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return " []";
    const items = value.map((item) => emitItem(item, indent)).join("");
    return `\n${items.replace(/\n$/, "")}`;
  }
  if (isRecord(value)) {
    const body = emitMapping(value, `${indent}  `);
    return body === "" ? " {}" : `\n${body.replace(/\n$/, "")}`;
  }
  return ` ${scalar(value)}`;
}

function emitItem(item: YamlValue, indent: string): string {
  if (isRecord(item)) {
    const body = emitMapping(item, `${indent}    `);
    if (body === "") return `${indent}  - {}\n`;
    // First key rides on the dash, the rest align under it.
    const lines = body.split("\n").filter((line) => line !== "");
    const first = lines[0].slice(indent.length + 4);
    const rest = lines.slice(1);
    return [`${indent}  - ${first}`, ...rest].join("\n") + "\n";
  }
  if (Array.isArray(item)) {
    return `${indent}  -${emitValue(item, `${indent}  `)}\n`;
  }
  return `${indent}  - ${scalar(item)}\n`;
}

function emitMapping(map: YamlMap, indent: string): string {
  let out = "";
  for (const [key, value] of Object.entries(map)) {
    // `undefined` is how callers express "omit this key". It is what keeps
    // `skip_serializing_if` fields (favorite, role, area…) out of the file
    // instead of writing `favorite: false` / `role: ""`.
    if (value === undefined) continue;
    out += `${indent}${key}:${emitValue(value, indent)}\n`;
  }
  return out;
}

/** Render a frontmatter mapping (no `---` fences). */
export function toYaml(map: YamlMap): string {
  return emitMapping(map, "");
}

/**
 * Assemble a complete record file. Bodies are stored trimmed of surrounding
 * newlines to match `normalize_body` in `src-tauri/src/parsers/mod.rs`, so a
 * parse/serialize cycle in the app does not rewrite the file.
 */
export function frontmatterDoc(map: YamlMap, body = ""): string {
  const trimmed = body.replace(/^\n+/, "").replace(/\n+$/, "");
  const yaml = toYaml(map);
  return trimmed === ""
    ? `---\n${yaml}---\n`
    : `---\n${yaml}---\n\n${trimmed}\n`;
}
