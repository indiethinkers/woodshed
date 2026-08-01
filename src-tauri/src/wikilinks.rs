use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

pub(crate) const WIKILINK_REWRITE_DIRS: &[&str] = &[
    "tasks",
    vault_lib::CADENCE_DIR,
    vault_lib::LEGACY_CALENDAR_DIR,
    vault_lib::LEGACY_DAILY_DIR,
    vault_lib::EVENTS_DIR,
    "people",
    "notebook",
    vault_lib::RESOURCES_DIR,
    vault_lib::AREAS_DIR,
    "inbox",
    "sent",
    "archive",
    "drafts",
    "tables",
];

/// Split a wikilink's inner text (between the brackets) into its resolution
/// `target` and displayed `text`. Obsidian convention: `[[Target|display]]`
/// resolves by the target and shows the display; a plain `[[Name]]` uses the
/// same value for both. Both halves are trimmed.
pub(crate) fn split_wikilink_inner(inner: &str) -> (&str, &str) {
    match inner.split_once('|') {
        Some((target, display)) => (target.trim(), display.trim()),
        None => {
            let t = inner.trim();
            (t, t)
        }
    }
}

pub(crate) fn safe_wikilink_label(title: &str, fallback_id: &str) -> String {
    let title = title.trim();
    let title_is_safe =
        !title.is_empty() && !title.chars().any(|c| matches!(c, '[' | ']' | '\n' | '\r'));
    if title_is_safe {
        title.to_string()
    } else {
        fallback_id.to_string()
    }
}

pub(crate) fn creation_trace_text(label: &str) -> String {
    format!("[[{}]]", label.trim())
}

pub(crate) fn collect_markdown_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if !crate::vault::is_real_directory(dir) {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if crate::vault::is_real_directory(&path) {
            collect_markdown_files(&path, out)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("md")
            && crate::vault::is_real_file(&path)
        {
            out.push(path);
        }
    }
    Ok(())
}

pub(crate) fn replace_wikilink_labels(
    raw: &str,
    old_labels: &[String],
    new_label: &str,
) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    let mut changed = false;

    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("]]") else {
            out.push_str(&rest[start..]);
            return changed.then_some(out);
        };
        let label = &after_open[..end];
        let (target, display) = split_wikilink_inner(label);
        if old_labels.iter().any(|old| labels_match(target, old)) {
            out.push_str("[[");
            out.push_str(new_label);
            // Preserve an alias (`[[old|alias]]` → `[[new|alias]]`); a plain
            // link rewrites to `[[new]]`.
            if label.contains('|') {
                out.push('|');
                out.push_str(display);
            }
            out.push_str("]]");
            changed = true;
        } else {
            out.push_str(&rest[start..start + 2 + end + 2]);
        }
        rest = &after_open[end + 2..];
    }

    out.push_str(rest);
    changed.then_some(out)
}

pub(crate) fn push_unique_label(labels: &mut Vec<String>, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || labels
            .iter()
            .any(|existing| labels_match(existing, trimmed))
    {
        return;
    }
    labels.push(trimmed.to_string());
}

pub(crate) fn labels_match(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// Historical scaffolding verbs that older create paths prepended before the
/// wikilink on the day's journal. New traces are bare `[[Label]]` entries, but
/// deletion cleanup still recognizes the old shape.
const CREATION_TRACE_PREFIXES: &[&str] = &["Created"];

/// Remove the auto-generated creation-trace bullets for `labels` from `raw`
/// — current `- [HH:MM] [[Label]]` lines and legacy `- [HH:MM] Created
/// [[Label]]` lines. Returns the rewritten text, or `None` when nothing
/// matched. Lines that merely *mention* a label inside other prose are left
/// alone (their link degrades to an unresolved placeholder per file-over-app);
/// only single-purpose creation traces are dropped.
pub(crate) fn remove_creation_trace_lines(raw: &str, labels: &[String]) -> Option<String> {
    if labels.is_empty() {
        return None;
    }
    let mut changed = false;
    let mut kept: Vec<&str> = Vec::new();
    for line in raw.lines() {
        if is_creation_trace_line(line, labels) {
            changed = true;
        } else {
            kept.push(line);
        }
    }
    if !changed {
        return None;
    }
    let mut out = kept.join("\n");
    if raw.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    Some(out)
}

/// True when `line` is *solely* an auto-generated creation trace for one of
/// `labels`: an optional bullet marker, an optional `[HH:MM]` timestamp, an
/// optional historical scaffolding verb, then exactly `[[Label]]` and nothing
/// else.
fn is_creation_trace_line(line: &str, labels: &[String]) -> bool {
    let Some(rest) = line.trim_start().strip_prefix(['-', '*', '+']) else {
        return false; // creation traces are always bullets
    };
    let rest = strip_log_timestamp(rest.trim_start()).trim_start();
    let rest = strip_creation_prefix(rest).trim();
    let Some(inner) = rest.strip_prefix("[[").and_then(|r| r.strip_suffix("]]")) else {
        return false;
    };
    if inner.contains("[[") || inner.contains("]]") {
        return false;
    }
    labels.iter().any(|label| labels_match(inner, label))
}

/// Strip a leading `[HH:MM]` daily-log timestamp, returning the remainder
/// (or the input unchanged when there's no timestamp).
fn strip_log_timestamp(s: &str) -> &str {
    let Some(rest) = s.strip_prefix('[') else {
        return s;
    };
    let Some(close) = rest.find(']') else {
        return s;
    };
    let inside = &rest[..close];
    let looks_like_time = inside.len() >= 3
        && inside.contains(':')
        && inside.chars().all(|c| c.is_ascii_digit() || c == ':');
    if looks_like_time {
        &rest[close + 1..]
    } else {
        s
    }
}

/// Strip a leading recognized scaffolding verb ("Created ") plus its trailing
/// whitespace, requiring a word boundary so "Createdness" doesn't match.
fn strip_creation_prefix(s: &str) -> &str {
    for prefix in CREATION_TRACE_PREFIXES {
        if let Some(rest) = s.strip_prefix(prefix) {
            if rest.starts_with(char::is_whitespace) {
                return rest.trim_start();
            }
        }
    }
    s
}

/// Scrub the auto-added creation-trace backlinks for a just-deleted record
/// from every markdown file in the rewrite dirs (in practice the day's
/// `cadence/<date>.md` the create logged to). Mirrors the write/index dance
/// of the title-change rewriters: an atomic write behind a self-write
/// fingerprint so the watcher doesn't echo, plus a synchronous index refresh.
/// Returns the number of files changed. Callers treat failures as non-fatal —
/// the record file is already gone; a journal hiccup shouldn't fail the delete.
pub(crate) fn remove_record_backlinks(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    labels: &[String],
) -> Result<usize, String> {
    if labels.is_empty() {
        return Ok(0);
    }
    let mut files = Vec::new();
    for subdir in WIKILINK_REWRITE_DIRS {
        collect_markdown_files(&crate::vault::collection_dir(vault, subdir), &mut files)?;
    }
    let mut changed = 0usize;
    for path in files {
        let raw = crate::vault::read_record(&path).map_err(|e| e.to_string())?;
        let Some(next) = remove_creation_trace_lines(&raw, labels) else {
            continue;
        };
        if let Some(watcher) = state.watcher.lock_recover().as_ref() {
            watcher.record_self_write(&path);
        }
        vault_lib::write_atomic(&path, &next).map_err(|e| e.to_string())?;
        if let Ok(idx) = state.ensure_index(app) {
            if let Err(e) = idx.refresh_path(vault, &path) {
                eprintln!("refresh backlinks {}: {}", path.display(), e);
            }
        }
        changed += 1;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_wikilink_label_uses_title_when_safe() {
        assert_eq!(
            safe_wikilink_label(" Deep Work in the age of AI ", "deep-work"),
            "Deep Work in the age of AI"
        );
    }

    #[test]
    fn safe_wikilink_label_falls_back_for_unsafe_title() {
        assert_eq!(safe_wikilink_label("Deep [Work]", "deep-work"), "deep-work");
        assert_eq!(safe_wikilink_label("", "deep-work"), "deep-work");
    }

    #[test]
    fn creation_trace_text_is_a_bare_wikilink() {
        assert_eq!(
            creation_trace_text(" Deep Work in the age of AI "),
            "[[Deep Work in the age of AI]]"
        );
    }

    #[test]
    fn backlink_rewrite_updates_title_and_id_links() {
        let old_labels = vec![
            "Deep Work in the age of AI".to_string(),
            "deep-work".to_string(),
        ];
        let raw = "- [[Deep Work in the age of AI]]\n- [[deep-work]]\n- [[Unrelated Resource]]";

        assert_eq!(
            replace_wikilink_labels(raw, &old_labels, "Deep Work and AI").as_deref(),
            Some("- [[Deep Work and AI]]\n- [[Deep Work and AI]]\n- [[Unrelated Resource]]")
        );
    }

    #[test]
    fn split_inner_separates_target_and_alias() {
        assert_eq!(
            split_wikilink_inner("Writer-Builders | writer"),
            ("Writer-Builders", "writer")
        );
        assert_eq!(
            split_wikilink_inner("Alex Rivera"),
            ("Alex Rivera", "Alex Rivera")
        );
    }

    #[test]
    fn backlink_rewrite_preserves_alias() {
        let old_labels = vec!["Writer-Builders".to_string()];
        let raw = "I'm a [[Writer-Builders|writer-builder]].";

        assert_eq!(
            replace_wikilink_labels(raw, &old_labels, "Builder-Writers").as_deref(),
            Some("I'm a [[Builder-Writers|writer-builder]].")
        );
    }

    #[test]
    fn backlink_rewrite_is_case_insensitive() {
        let old_labels = vec!["Deep Work in the age of AI".to_string()];
        let raw = "- [[deep work in the age of ai]]";

        assert_eq!(
            replace_wikilink_labels(raw, &old_labels, "Deep Work and AI").as_deref(),
            Some("- [[Deep Work and AI]]")
        );
    }

    #[test]
    fn backlink_rewrite_ignores_plain_text_mentions() {
        let old_labels = vec!["Deep Work in the age of AI".to_string()];
        let raw = "Deep Work in the age of AI\n\n[[Other]]";

        assert_eq!(
            replace_wikilink_labels(raw, &old_labels, "Deep Work and AI"),
            None
        );
    }

    #[test]
    fn remove_trace_drops_bare_link() {
        let labels = vec![
            "Local-first software".to_string(),
            "local-first".to_string(),
        ];
        let raw =
            "- [09:12] [[Alex Rivera]]\n- [10:30] [[Local-first software]]\n- [11:00] [[Other]]";

        assert_eq!(
            remove_creation_trace_lines(raw, &labels).as_deref(),
            Some("- [09:12] [[Alex Rivera]]\n- [11:00] [[Other]]")
        );
    }

    #[test]
    fn remove_trace_drops_created_prefixed_link() {
        let labels = vec!["Alex Rivera".to_string(), "alex-rivera".to_string()];
        let raw = "- [09:12] Created [[Alex Rivera]]\n- [10:00] Created [[Someone Else]]";

        assert_eq!(
            remove_creation_trace_lines(raw, &labels).as_deref(),
            Some("- [10:00] Created [[Someone Else]]")
        );
    }

    #[test]
    fn remove_trace_is_case_insensitive_and_matches_id() {
        let labels = vec!["alex-rivera".to_string()];
        let raw = "- [09:12] Created [[alex-rivera]]";

        assert_eq!(
            remove_creation_trace_lines(raw, &labels).as_deref(),
            Some("")
        );
    }

    #[test]
    fn remove_trace_keeps_prose_mentions() {
        // A user-authored bullet that mentions the record is left intact (its
        // link just becomes an unresolved placeholder) — only single-purpose
        // creation traces are scrubbed.
        let labels = vec!["Local-first software".to_string()];
        let raw = "- [09:12] Reviewed [[Local-first software]] and decided to pass";

        assert_eq!(remove_creation_trace_lines(raw, &labels), None);
    }

    #[test]
    fn remove_trace_preserves_trailing_newline() {
        let labels = vec!["Note".to_string()];
        let raw = "intro\n- [09:00] Created [[Note]]\n";

        assert_eq!(
            remove_creation_trace_lines(raw, &labels).as_deref(),
            Some("intro\n")
        );
    }

    #[test]
    fn remove_trace_returns_none_when_nothing_matches() {
        let labels = vec!["Ghost".to_string()];
        let raw = "- [09:00] Created [[Real Thing]]";
        assert_eq!(remove_creation_trace_lines(raw, &labels), None);
    }
}
