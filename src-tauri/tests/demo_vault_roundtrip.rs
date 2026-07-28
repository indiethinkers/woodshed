//! Roundtrip check for a generated demo vault.
//!
//! A malformed record is *silently* skipped at index time — no error surfaces
//! in the UI, the record simply is not there. That failure mode is invisible
//! until you are demoing and a surface is unexpectedly empty, so the generator
//! in `scripts/demo-vault/` needs a guard that runs against real output.
//!
//! For every `.md` file this asserts two things:
//!   1. it parses through the same parser the app uses, and
//!   2. re-serializing what parsed and parsing again yields an equal struct.
//!
//! The second check is stability, not byte-identity. The generator emits valid,
//! unambiguous YAML rather than trying to reproduce serde_yaml's exact output —
//! byte-matching a serializer from TypeScript would be fragile without making
//! any record more correct.
//!
//! Skipped (green) when `WOODSHED_DEMO_VAULT` is unset, so CI stays clean:
//!
//! ```sh
//! bun run demo:vault -- --out /tmp/demo-vault
//! WOODSHED_DEMO_VAULT=/tmp/demo-vault \
//!   cargo test --manifest-path src-tauri/Cargo.toml --test demo_vault_roundtrip
//! ```

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use woodshed_lib::{agent, parsers, sweep};

/// Vault-relative directory → the parser that owns records in it.
const CHECKS: &[(&str, Kind)] = &[
    ("tasks", Kind::Task),
    ("events", Kind::Event),
    ("cadence", Kind::Daily),
    ("people", Kind::Person),
    ("notebook", Kind::Note),
    ("resources", Kind::Resource),
    ("areas", Kind::Area),
    ("agent", Kind::AgentChat),
    ("sweep", Kind::SweepCard),
    ("inbox", Kind::Email),
    ("sent", Kind::Email),
    ("archive", Kind::Email),
    ("drafts", Kind::Draft),
];

#[derive(Clone, Copy, Debug)]
enum Kind {
    Task,
    Event,
    Daily,
    Person,
    Note,
    Resource,
    Area,
    AgentChat,
    SweepCard,
    Email,
    Draft,
}

/// On-disk mail frontmatter. `parse_email_md` is private to `commands::mail`,
/// so this mirrors the key set that `render_email_md` writes
/// (`src-tauri/src/commands/mail.rs:1410`). Deserializing into it proves the
/// YAML is well formed and every field carries the type the reader expects,
/// which is the failure this test exists to catch.
#[derive(Debug, Deserialize)]
struct EmailFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    thread: String,
    inbox: String,
    from: String,
    from_email: String,
    subject: String,
    #[serde(default)]
    preview: String,
    date: String,
    read: bool,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    mentions: Vec<String>,
    #[serde(default)]
    links: Vec<String>,
}

/// On-disk draft frontmatter — mirrors `render_draft_md` (mail.rs:1477).
#[derive(Debug, Deserialize)]
struct DraftFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    kind: String,
    created: String,
    #[serde(default)]
    from_inbox: String,
    #[serde(default)]
    to: Vec<String>,
    #[serde(default)]
    cc: Vec<String>,
    #[serde(default)]
    bcc: Vec<String>,
    subject: String,
}

fn demo_vault() -> Option<PathBuf> {
    let raw = std::env::var("WOODSHED_DEMO_VAULT").ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(raw))
}

fn markdown_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(markdown_files(&path));
        } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
            out.push(path);
        }
    }
    out.sort();
    out
}

/// Split frontmatter out of a record and deserialize it into `T`.
fn parse_frontmatter<T: for<'de> Deserialize<'de>>(content: &str) -> Result<T, String> {
    let rest = content
        .strip_prefix("---\n")
        .ok_or_else(|| "file does not start with a frontmatter fence".to_string())?;
    let end = rest
        .find("\n---\n")
        .or_else(|| rest.strip_suffix("\n---").map(|s| s.len()))
        .ok_or_else(|| "frontmatter fence is not closed".to_string())?;
    serde_yaml::from_str::<T>(&rest[..end]).map_err(|e| e.to_string())
}

/// parse → serialize → parse, requiring the two parses to agree. Written as a
/// macro because each record type has its own concrete struct and parser pair,
/// so there is no trait to be generic over.
macro_rules! round_trip {
    ($label:literal, $parse:path, $serialize:path, $content:expr) => {{
        let first = $parse($content).map_err(|e| format!("{e:#}"))?;
        let round = $serialize(&first).map_err(|e| format!("{e:#}"))?;
        let second = $parse(&round).map_err(|e| format!("{e:#}"))?;
        if first == second {
            Ok(())
        } else {
            Err(concat!($label, " did not round-trip").to_string())
        }
    }};
}

/// Parse, re-serialize, parse again, and require the two parses to agree.
fn check(kind: Kind, path: &Path, content: &str) -> Result<(), String> {
    let rel = path.display().to_string();
    match kind {
        Kind::Task => round_trip!(
            "task",
            parsers::parse_task,
            parsers::serialize_task,
            content
        ),
        Kind::Event => round_trip!(
            "event",
            parsers::parse_event,
            parsers::serialize_event,
            content
        ),
        Kind::Daily => round_trip!(
            "daily",
            parsers::parse_daily,
            parsers::serialize_daily,
            content
        ),
        Kind::Person => round_trip!(
            "person",
            parsers::parse_person,
            parsers::serialize_person,
            content
        ),
        Kind::Note => round_trip!(
            "note",
            parsers::parse_note,
            parsers::serialize_note,
            content
        ),
        Kind::Resource => round_trip!(
            "resource",
            parsers::parse_resource,
            parsers::serialize_resource,
            content
        ),
        Kind::Area => round_trip!(
            "area",
            parsers::parse_area,
            parsers::serialize_area,
            content
        ),
        Kind::AgentChat => {
            let first = agent::parse_chat(content, &rel).map_err(|e| format!("{e:#}"))?;
            let round = agent::serialize_chat(&first).map_err(|e| format!("{e:#}"))?;
            let second = agent::parse_chat(&round, &rel).map_err(|e| format!("{e:#}"))?;
            (first.id == second.id
                && first.title == second.title
                && first.messages.len() == second.messages.len())
            .then_some(())
            .ok_or("agent chat did not round-trip".into())
        }
        Kind::SweepCard => {
            let first = sweep::parse_card(content, &rel).map_err(|e| format!("{e:#}"))?;
            let round = sweep::serialize_card(&first).map_err(|e| format!("{e:#}"))?;
            let second = sweep::parse_card(&round, &rel).map_err(|e| format!("{e:#}"))?;
            (first.id == second.id
                && first.headline == second.headline
                && first.timeline.len() == second.timeline.len())
            .then_some(())
            .ok_or("sweep card did not round-trip".into())
        }
        Kind::Email => {
            let fm: EmailFrontmatter = parse_frontmatter(content)?;
            if fm.type_ != "email" {
                return Err(format!("expected type=email, got {}", fm.type_));
            }
            for (name, value) in [
                ("id", &fm.id),
                ("thread", &fm.thread),
                ("inbox", &fm.inbox),
                ("from", &fm.from),
                ("from_email", &fm.from_email),
                ("subject", &fm.subject),
                ("date", &fm.date),
            ] {
                if value.trim().is_empty() {
                    return Err(format!("email field `{name}` is empty"));
                }
            }
            // Read state is derived from labels (mail.rs:16); a mismatch would
            // show the wrong unread count on the Mail surface.
            let says_read = fm.labels.iter().any(|l| l == "read");
            if says_read != fm.read {
                return Err(format!(
                    "read flag ({}) disagrees with labels ({:?})",
                    fm.read, fm.labels
                ));
            }
            let _ = (&fm.preview, &fm.mentions, &fm.links);
            Ok(())
        }
        Kind::Draft => {
            let fm: DraftFrontmatter = parse_frontmatter(content)?;
            if fm.type_ != "draft" {
                return Err(format!("expected type=draft, got {}", fm.type_));
            }
            if !matches!(fm.kind.as_str(), "new" | "reply") {
                return Err(format!("unexpected draft kind `{}`", fm.kind));
            }
            if fm.id.trim().is_empty() || fm.created.trim().is_empty() {
                return Err("draft id/created must be set".into());
            }
            let _ = (&fm.from_inbox, &fm.to, &fm.cc, &fm.bcc, &fm.subject);
            Ok(())
        }
    }
}

#[test]
fn every_generated_record_parses_and_round_trips() {
    let Some(vault) = demo_vault() else {
        eprintln!("WOODSHED_DEMO_VAULT unset — skipping demo vault roundtrip");
        return;
    };
    assert!(
        vault.is_dir(),
        "WOODSHED_DEMO_VAULT is not a directory: {}",
        vault.display()
    );

    let mut failures: Vec<String> = Vec::new();
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();

    for (subdir, kind) in CHECKS {
        for path in markdown_files(&vault.join(subdir)) {
            let content = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(e) => {
                    failures.push(format!("{}: read failed: {e}", path.display()));
                    continue;
                }
            };
            match check(*kind, &path, &content) {
                Ok(()) => *counts.entry(subdir).or_default() += 1,
                Err(e) => failures.push(format!("{}: {e}", path.display())),
            }
        }
    }

    // Tables are nested one directory per table: `_schema.md` plus row files.
    for table_dir in std::fs::read_dir(vault.join("tables"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
    {
        for path in markdown_files(&table_dir) {
            let content = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(e) => {
                    failures.push(format!("{}: read failed: {e}", path.display()));
                    continue;
                }
            };
            let is_schema = path.file_name().and_then(|s| s.to_str()) == Some("_schema.md");
            let result = if is_schema {
                parsers::parse_table_schema(&content)
                    .map_err(|e| format!("{e:#}"))
                    .and_then(|first| {
                        let round = parsers::serialize_table_schema(&first)
                            .map_err(|e| format!("{e:#}"))?;
                        let second =
                            parsers::parse_table_schema(&round).map_err(|e| format!("{e:#}"))?;
                        (first == second)
                            .then_some(())
                            .ok_or_else(|| "table schema did not round-trip".to_string())
                    })
            } else {
                parsers::parse_row(&content)
                    .map_err(|e| format!("{e:#}"))
                    .and_then(|first| {
                        let round = parsers::serialize_row(&first).map_err(|e| format!("{e:#}"))?;
                        let second = parsers::parse_row(&round).map_err(|e| format!("{e:#}"))?;
                        (first == second)
                            .then_some(())
                            .ok_or_else(|| "table row did not round-trip".to_string())
                    })
            };
            match result {
                Ok(()) => *counts.entry("tables").or_default() += 1,
                Err(e) => failures.push(format!("{}: {e}", path.display())),
            }
        }
    }

    let checked: usize = counts.values().sum();
    eprintln!("checked {checked} records: {counts:?}");

    assert!(
        failures.is_empty(),
        "{} record(s) failed to parse or round-trip:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
    assert!(
        checked > 200,
        "expected a populated demo vault, only checked {checked} records"
    );
}
