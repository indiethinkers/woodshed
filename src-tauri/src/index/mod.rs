// SQLite + FTS5 search index over the vault.
//
// One `documents` table holds a flattened view of every searchable record
// (tasks, events, dailies, notes, people, resources, areas, agent chats, mail, table rows). A companion FTS5 virtual
// table mirrors `title`, `body`, and `hint` via triggers — search hits join
// back to `documents` for the metadata we need to render a result row.
//
// Writes flow in two ways:
//   1. Synchronously from each Tauri command (`upsert_doc`/`delete_by_path`)
//      so a record is searchable the instant it lands on disk.
//   2. From the watcher callback for non-self-write paths so external edits
//      get reflected.
//
// The index lives at `<app_data_dir>/index.db`. It is a derivative of the
// vault — losing it is annoying but not catastrophic; `rebuild_from_vault`
// regenerates everything.

use crate::agent;
use crate::commands::mail;
use crate::parsers;
use crate::sync_ext::MutexRecover;
use crate::wikilinks::{labels_match, split_wikilink_inner};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS documents (
    rowid       INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    hint        TEXT,
    href        TEXT NOT NULL,
    area        TEXT,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);

CREATE TABLE IF NOT EXISTS index_metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_links (
    source_path TEXT NOT NULL,
    target      TEXT NOT NULL,
    ordinal     INTEGER NOT NULL,
    PRIMARY KEY (source_path, target)
);
CREATE INDEX IF NOT EXISTS idx_document_links_target
    ON document_links(target COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS document_tags (
    source_path TEXT NOT NULL,
    tag         TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (source_path, tag)
);
CREATE INDEX IF NOT EXISTS idx_document_tags_tag
    ON document_tags(tag COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS mail_summaries (
    path         TEXT PRIMARY KEY,
    thread_id    TEXT NOT NULL,
    date_ms      INTEGER NOT NULL,
    summary_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_summaries_date
    ON mail_summaries(date_ms DESC, path);
CREATE INDEX IF NOT EXISTS idx_mail_summaries_thread
    ON mail_summaries(thread_id, date_ms, path);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title, body, hint,
    content='documents', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, body, hint)
    VALUES (new.rowid, new.title, new.body, new.hint);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, body, hint)
    VALUES ('delete', old.rowid, old.title, old.body, old.hint);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, body, hint)
    VALUES ('delete', old.rowid, old.title, old.body, old.hint);
    INSERT INTO documents_fts(rowid, title, body, hint)
    VALUES (new.rowid, new.title, new.body, new.hint);
END;
"#;

#[derive(Debug, Clone)]
pub struct IndexedDoc {
    pub kind: &'static str,
    pub doc_id: String,
    pub path: String,
    pub title: String,
    pub body: String,
    pub hint: Option<String>,
    pub href: String,
    pub area: Option<String>,
    /// Explicit and implicit tags supplied by the parser. Inline hashtags
    /// are extracted from `body` during upsert for taggable record kinds.
    pub tags: Vec<String>,
    pub updated_at: i64,
}

/// One entry in the wikilink resolution map. The frontend keys these by
/// lowercased title and id so `[[Alex Rivera]]` and `[[alex-rivera]]` both
/// resolve to the same person record.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkTargetRow {
    pub kind: String,
    pub doc_id: String,
    pub title: String,
    pub href: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub kind: String,
    pub doc_id: String,
    pub path: String,
    pub title: String,
    pub hint: Option<String>,
    pub href: String,
    pub area: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkEntry {
    pub source: String,
    pub title: String,
    pub href: String,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingLinkEntry {
    pub label: String,
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Process-lifetime handle wrapping the connection. Single connection guarded
/// by a mutex — fine for our write volume (single user, low qps).
pub struct IndexHandle {
    conn: Mutex<Connection>,
}

impl IndexHandle {
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create index dir {}", parent.display()))?;
        }
        let mut conn = Connection::open(db_path)
            .with_context(|| format!("open index db {}", db_path.display()))?;
        conn.execute_batch(SCHEMA_SQL).context("apply schema")?;
        migrate_space_to_area(&conn).context("migrate space → area column")?;
        backfill_normalized_edges_once(&mut conn).context("backfill normalized index edges")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn upsert(&self, doc: &IndexedDoc) -> Result<()> {
        let mut conn = self.conn.lock_recover();
        let tx = conn.transaction()?;
        upsert_with(&tx, doc)?;
        tx.commit()?;
        Ok(())
    }

    pub fn upsert_email(&self, doc: &IndexedDoc, email: &mail::EmailSummary) -> Result<()> {
        let mut conn = self.conn.lock_recover();
        let tx = conn.transaction()?;
        upsert_with(&tx, doc)?;
        upsert_mail_summary_with(&tx, &doc.path, email)?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_by_path(&self, path: &str) -> Result<()> {
        let mut conn = self.conn.lock_recover();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM document_links WHERE source_path = ?1",
            params![path],
        )
        .context("delete document links by path")?;
        tx.execute(
            "DELETE FROM document_tags WHERE source_path = ?1",
            params![path],
        )
        .context("delete document tags by path")?;
        tx.execute("DELETE FROM mail_summaries WHERE path = ?1", params![path])
            .context("delete mail summary by path")?;
        tx.execute("DELETE FROM documents WHERE path = ?1", params![path])
            .context("delete doc by path")?;
        tx.commit()?;
        Ok(())
    }

    pub fn mail_inbox_page(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<mail::EmailSummary>, Option<usize>)> {
        let conn = self.conn.lock_recover();
        let mut stmt = conn.prepare(
            "SELECT summary_json FROM mail_summaries \
             WHERE path LIKE 'inbox/%' \
             ORDER BY date_ms DESC, path \
             LIMIT ?1 OFFSET ?2",
        )?;
        let rows = stmt
            .query_map(params![(limit + 1) as i64, offset as i64], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let has_more = rows.len() > limit;
        let items = rows
            .into_iter()
            .take(limit)
            .map(|json| serde_json::from_str(&json).context("decode indexed mail summary"))
            .collect::<Result<Vec<_>>>()?;
        let next_offset = has_more.then_some(offset.saturating_add(items.len()));
        Ok((items, next_offset))
    }

    pub fn mail_thread_paths(&self, thread_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock_recover();
        let mut stmt = conn.prepare(
            "SELECT path FROM mail_summaries WHERE thread_id = ?1 \
             ORDER BY date_ms, path LIMIT 1000",
        )?;
        let paths = stmt
            .query_map(params![thread_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(paths)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let Some(fts_query) = build_fts_query(query) else {
            return Ok(Vec::new());
        };
        let conn = self.conn.lock_recover();
        let mut stmt = conn.prepare(
            "SELECT d.kind, d.doc_id, d.path, d.title, d.hint, d.href, d.area \
             FROM documents_fts f \
             JOIN documents d ON d.rowid = f.rowid \
             WHERE f.documents_fts MATCH ?1 \
             ORDER BY rank \
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![fts_query, limit as i64], |row| {
            Ok(SearchHit {
                kind: row.get(0)?,
                doc_id: row.get(1)?,
                path: row.get(2)?,
                title: row.get(3)?,
                hint: row.get(4)?,
                href: row.get(5)?,
                area: row.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn document_count(&self) -> Result<i64> {
        let conn = self.conn.lock_recover();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))?;
        Ok(count)
    }

    /// Older index databases predate normalized tag edges. Returning true
    /// forces one background vault rebuild, after which this marker is set.
    pub fn requires_tag_index_rebuild(&self) -> Result<bool> {
        let conn = self.conn.lock_recover();
        let value = conn
            .query_row(
                "SELECT value FROM index_metadata WHERE key = ?1",
                params!["normalized_tags_v1"],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let mail_value = conn
            .query_row(
                "SELECT value FROM index_metadata WHERE key = 'mail_summaries_v1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value.as_deref() != Some("1") || mail_value.as_deref() != Some("1"))
    }

    /// Return only the vault-relative paths carrying `tag`. Tag-table
    /// commands use this as a prefilter, then parse those few records into
    /// their rich per-type DTOs instead of reparsing the entire vault.
    pub fn tagged_paths(&self, tag: &str) -> Result<std::collections::HashSet<String>> {
        let tag = normalize_tag(tag);
        if tag.is_empty() {
            return Ok(std::collections::HashSet::new());
        }
        let conn = self.conn.lock_recover();
        let mut stmt =
            conn.prepare("SELECT source_path FROM document_tags WHERE tag = ?1 COLLATE NOCASE")?;
        let paths = stmt
            .query_map(params![tag], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<std::collections::HashSet<_>, _>>()?;
        Ok(paths)
    }

    /// Count normalized tags without reading vault files. Each source file
    /// contributes at most once per tag because document_tags is unique on
    /// `(source_path, tag)`.
    pub fn tag_counts(&self) -> Result<Vec<(String, usize)>> {
        let conn = self.conn.lock_recover();
        let mut stmt = conn.prepare(
            "SELECT tag, COUNT(*) FROM document_tags GROUP BY tag ORDER BY COUNT(*) DESC, tag",
        )?;
        let counts = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(counts)
    }

    /// Bulk listing of every wikilink-resolvable target. Excludes daily pages
    /// (which are date-routes, not nameable entities). Powers the
    /// `wikilink_targets` Tauri command consumed by the frontend resolver.
    pub fn list_wikilink_targets(&self) -> Result<Vec<WikilinkTargetRow>> {
        let conn = self.conn.lock_recover();
        let mut stmt = conn.prepare(
            "SELECT kind, doc_id, title, href \
             FROM documents \
             WHERE kind IN ('note', 'person', 'event', 'resource', 'task', 'area', 'agent_chat', 'mail', 'row') \
             ORDER BY kind, title",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(WikilinkTargetRow {
                kind: row.get(0)?,
                doc_id: row.get(1)?,
                title: row.get(2)?,
                href: row.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn backlinks_for_target(&self, target: &str) -> Result<Vec<BacklinkEntry>> {
        let target = target.trim();
        if target.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock_recover();
        let target_title = conn
            .query_row(
                "SELECT title FROM documents \
                 WHERE doc_id = ?1 OR lower(title) = lower(?1) \
                 LIMIT 1",
                params![target],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        let mut labels = vec![target.to_string()];
        if let Some(title) = target_title.as_ref() {
            push_distinct_label(&mut labels, title.clone());
        }

        let second_label = target_title.as_deref().unwrap_or(target);
        let mut stmt = conn.prepare(
            "SELECT DISTINCT d.kind, d.doc_id, d.path, d.title, d.body, d.href \
             FROM document_links l \
             JOIN documents d ON d.path = l.source_path \
             WHERE lower(l.target) = lower(?1) OR lower(l.target) = lower(?2) \
             ORDER BY d.updated_at DESC, d.title",
        )?;
        let rows = stmt.query_map(params![target, second_label], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (kind, doc_id, path, title, body, href) = row?;
            if labels.iter().any(|label| labels_match(&doc_id, label))
                || labels.iter().any(|label| labels_match(&path, label))
            {
                continue;
            }
            out.push(BacklinkEntry {
                source: path,
                title: strip_wikilinks(&title),
                href,
                type_: kind,
                preview: wikilink_preview(&body, &labels),
            });
        }
        Ok(out)
    }

    pub fn outgoing_links_for_source(&self, source: &str) -> Result<Vec<OutgoingLinkEntry>> {
        let source = source.trim();
        if source.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock_recover();
        let source_doc = conn
            .query_row(
                "SELECT path FROM documents \
                 WHERE doc_id = ?1 OR path = ?1 OR lower(title) = lower(?1) \
                 LIMIT 1",
                params![source],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(source_path) = source_doc else {
            return Ok(Vec::new());
        };

        let mut label_stmt = conn
            .prepare("SELECT target FROM document_links WHERE source_path = ?1 ORDER BY ordinal")?;
        let labels = label_stmt
            .query_map(params![source_path], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut out = Vec::new();
        for label in labels {
            let target = conn
                .query_row(
                    "SELECT kind, doc_id, path, title, href \
                     FROM documents \
                     WHERE lower(doc_id) = lower(?1) OR lower(title) = lower(?1) \
                     LIMIT 1",
                    params![label],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((kind, _doc_id, path, title, href)) = target {
                out.push(OutgoingLinkEntry {
                    label,
                    resolved: true,
                    title: Some(strip_wikilinks(&title)),
                    href: Some(href),
                    type_: Some(kind),
                    path: Some(path),
                });
            } else {
                out.push(OutgoingLinkEntry {
                    label,
                    resolved: false,
                    title: None,
                    href: None,
                    type_: None,
                    path: None,
                });
            }
        }
        Ok(out)
    }

    /// Wipe the index and re-scan every supported subdirectory of the vault.
    /// Used for cold start (when the DB is empty), the user-facing
    /// "Reset & re-scan" button, and recovery after a missed watcher event.
    pub fn rebuild_from_vault(&self, vault_root: &Path) -> Result<usize> {
        let mut conn = self.conn.lock_recover();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM document_links", [])?;
        tx.execute("DELETE FROM document_tags", [])?;
        tx.execute("DELETE FROM mail_summaries", [])?;
        tx.execute("DELETE FROM documents", [])?;
        let mut count = 0usize;
        // After the daily-into-cadence merger, multiple Kind variants
        // share the same subdir (Kind::Event and Kind::Daily both live
        // in cadence/). Dedupe the directory scan so we don't visit the
        // same file twice; per-file classification in doc_from_path
        // routes each file to the right parser.
        let mut seen = std::collections::HashSet::new();
        let mut scan =
            |subdir: &str, tx: &rusqlite::Transaction, count: &mut usize| -> Result<()> {
                if !seen.insert(subdir.to_string()) {
                    return Ok(());
                }
                let dir = vault_root.join(subdir);
                if !crate::vault::is_real_directory(&dir) {
                    return Ok(());
                }
                for entry in std::fs::read_dir(&dir)? {
                    let entry = entry?;
                    let path = entry.path();
                    if path.extension().and_then(|s| s.to_str()) != Some("md")
                        || !crate::vault::is_real_file(&path)
                    {
                        continue;
                    }
                    match doc_from_path(vault_root, &path) {
                        Ok(Some(doc)) => {
                            upsert_with(tx, &doc)?;
                            if doc.kind == "mail" {
                                if let Some(summary) = mail::load_email_summary_from_path(&path) {
                                    upsert_mail_summary_with(tx, &doc.path, &summary)?;
                                }
                            }
                            *count += 1;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            eprintln!("index: skipped {}: {}", path.display(), e);
                        }
                    }
                }
                Ok(())
            };
        for kind in ALL_KINDS {
            scan(kind.subdir(), &tx, &mut count)?;
        }
        // Pre-migration vaults still have files under daily/. Pick
        // them up so the search index works during the transition;
        // migrate_legacy_folders empties the folder on next boot.
        scan("daily", &tx, &mut count)?;
        for subdir in ["inbox", "sent", "archive"] {
            scan(subdir, &tx, &mut count)?;
        }
        scan_table_rows(vault_root, &tx, &mut count)?;
        tx.execute(
            "INSERT INTO index_metadata (key, value) VALUES ('normalized_tags_v1', '1') \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )?;
        tx.execute(
            "INSERT INTO index_metadata (key, value) VALUES ('mail_summaries_v1', '1') \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )?;
        tx.commit()?;
        Ok(count)
    }

    /// Re-read a single vault path and refresh its index entry. If the file
    /// no longer exists, the entry is deleted. Errors on a single record are
    /// logged and swallowed — bad data on disk shouldn't break indexing.
    pub fn refresh_path(&self, vault_root: &Path, abs_path: &Path) -> Result<()> {
        let rel = match abs_path.strip_prefix(vault_root) {
            Ok(r) => r.to_string_lossy().to_string(),
            Err(_) => return Ok(()),
        };
        if !abs_path.exists() {
            return self.delete_by_path(&rel);
        }
        // Watcher fires for directories too (macOS notifies the parent dir
        // when its children change). Skip anything that isn't a markdown
        // file so we don't try to read_to_string a directory.
        if !crate::vault::is_real_file(abs_path)
            || abs_path.extension().and_then(|s| s.to_str()) != Some("md")
        {
            return Ok(());
        }
        match doc_from_path(vault_root, abs_path) {
            Ok(Some(doc)) if doc.kind == "mail" => {
                if let Some(summary) = mail::load_email_summary_from_path(abs_path) {
                    self.upsert_email(&doc, &summary)
                } else {
                    self.delete_by_path(&rel)
                }
            }
            Ok(Some(doc)) => self.upsert(&doc),
            Ok(None) => self.delete_by_path(&rel),
            Err(e) => {
                eprintln!("index: refresh {} failed: {}", abs_path.display(), e);
                Ok(())
            }
        }
    }
}

/// One-time rename of the `space` column to `area` for indexes built
/// before the Spaces → Areas rename. SQLite supports `ALTER TABLE …
/// RENAME COLUMN` natively, and we only run this when the legacy
/// column is still present and the new one isn't yet.
fn migrate_space_to_area(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(documents)")?;
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<_, _>>()?;
    let has_space = cols.iter().any(|c| c == "space");
    let has_area = cols.iter().any(|c| c == "area");
    if has_space && !has_area {
        conn.execute("ALTER TABLE documents RENAME COLUMN space TO area", [])
            .context("ALTER TABLE space → area")?;
    }
    Ok(())
}

fn backfill_normalized_edges_once(conn: &mut Connection) -> Result<()> {
    let complete = conn
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'normalized_edges_backfill_v1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .as_deref()
        == Some("1");
    if complete {
        return Ok(());
    }
    let tx = conn.transaction()?;
    backfill_document_links(&tx).context("backfill document link edges")?;
    backfill_document_tags(&tx).context("backfill document tag edges")?;
    tx.execute(
        "INSERT INTO index_metadata (key, value) VALUES ('normalized_edges_backfill_v1', '1') \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

fn backfill_document_links(conn: &Connection) -> Result<()> {
    let docs = {
        let mut stmt = conn.prepare(
            "SELECT path, title, body FROM documents d \
             WHERE NOT EXISTS (SELECT 1 FROM document_links l WHERE l.source_path = d.path)",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for (path, title, body) in docs {
        for (ordinal, target) in extract_wikilink_labels(&format!("{title}\n{body}"))
            .into_iter()
            .enumerate()
        {
            conn.execute(
                "INSERT OR IGNORE INTO document_links (source_path, target, ordinal) VALUES (?1, ?2, ?3)",
                params![path, target, ordinal as i64],
            )?;
        }
    }
    Ok(())
}

fn backfill_document_tags(conn: &Connection) -> Result<()> {
    let docs = {
        let mut stmt = conn.prepare(
            "SELECT path, kind, body FROM documents d \
             WHERE NOT EXISTS (SELECT 1 FROM document_tags t WHERE t.source_path = d.path)",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for (path, kind, body) in docs {
        if !is_taggable_kind(&kind) {
            continue;
        }
        let mut tags = extract_inline_tags(&body);
        // Legacy event rows do not retain provider metadata. This temporary
        // implicit edge is replaced by the required one-time vault rebuild,
        // which can distinguish local events from iCal note attachments.
        if kind == "event" {
            tags.push("event".to_string());
        }
        for tag in tags {
            conn.execute(
                "INSERT OR IGNORE INTO document_tags (source_path, tag) VALUES (?1, ?2)",
                params![path, tag],
            )?;
        }
    }
    Ok(())
}

fn scan_table_rows(vault_root: &Path, tx: &rusqlite::Transaction, count: &mut usize) -> Result<()> {
    let root = vault_root.join("tables");
    if !crate::vault::is_real_directory(&root) {
        return Ok(());
    }
    for table_entry in std::fs::read_dir(&root)? {
        let table_entry = table_entry?;
        let table_dir = table_entry.path();
        if !crate::vault::is_real_directory(&table_dir) {
            continue;
        }
        for row_entry in std::fs::read_dir(&table_dir)? {
            let row_entry = row_entry?;
            let path = row_entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md")
                || path.file_name().and_then(|s| s.to_str()) == Some("_schema.md")
                || !crate::vault::is_real_file(&path)
            {
                continue;
            }
            match doc_from_path(vault_root, &path) {
                Ok(Some(doc)) => {
                    upsert_with(tx, &doc)?;
                    *count += 1;
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("index: skipped {}: {}", path.display(), e);
                }
            }
        }
    }
    Ok(())
}

fn upsert_with(conn: &Connection, doc: &IndexedDoc) -> Result<()> {
    conn.execute(
        "INSERT INTO documents (kind, doc_id, path, title, body, hint, href, area, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(path) DO UPDATE SET \
             kind = excluded.kind, \
             doc_id = excluded.doc_id, \
             title = excluded.title, \
             body = excluded.body, \
             hint = excluded.hint, \
             href = excluded.href, \
             area = excluded.area, \
             updated_at = excluded.updated_at",
        params![
            doc.kind,
            doc.doc_id,
            doc.path,
            doc.title,
            doc.body,
            doc.hint,
            doc.href,
            doc.area,
            doc.updated_at,
        ],
    )
    .context("upsert document")?;
    conn.execute(
        "DELETE FROM document_links WHERE source_path = ?1",
        params![doc.path],
    )?;
    for (ordinal, target) in extract_wikilink_labels(&format!("{}\n{}", doc.title, doc.body))
        .into_iter()
        .enumerate()
    {
        conn.execute(
            "INSERT OR IGNORE INTO document_links (source_path, target, ordinal) VALUES (?1, ?2, ?3)",
            params![doc.path, target, ordinal as i64],
        )?;
    }
    conn.execute(
        "DELETE FROM document_tags WHERE source_path = ?1",
        params![doc.path],
    )?;
    if is_taggable_kind(doc.kind) {
        let mut tags = doc.tags.clone();
        tags.extend(extract_inline_tags(&doc.body));
        for tag in tags {
            let tag = normalize_tag(&tag);
            if tag.is_empty() || is_css_hex_literal(&tag) {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO document_tags (source_path, tag) VALUES (?1, ?2)",
                params![doc.path, tag],
            )?;
        }
    }
    Ok(())
}

fn upsert_mail_summary_with(
    conn: &Connection,
    path: &str,
    email: &mail::EmailSummary,
) -> Result<()> {
    let mut summary = email.clone();
    summary.body.clear();
    summary.html = None;
    let summary_json = serde_json::to_string(&summary).context("encode indexed mail summary")?;
    let date_ms = chrono::DateTime::parse_from_rfc3339(&summary.date)
        .map(|date| date.timestamp_millis())
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO mail_summaries (path, thread_id, date_ms, summary_json) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(path) DO UPDATE SET \
           thread_id = excluded.thread_id, \
           date_ms = excluded.date_ms, \
           summary_json = excluded.summary_json",
        params![path, summary.thread_id, date_ms, summary_json],
    )
    .context("upsert mail summary")?;
    Ok(())
}

fn is_taggable_kind(kind: &str) -> bool {
    matches!(
        kind,
        "event" | "task" | "note" | "person" | "resource" | "area" | "row"
    )
}

fn normalize_tag(tag: &str) -> String {
    tag.trim().trim_start_matches('#').to_lowercase()
}

/// Extract normalized inline hashtags using the same conservative grammar as
/// the tag-table UI. Numeric fragments and unmistakable CSS colors are not
/// user tags.
pub(crate) fn extract_inline_tags(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lowered = body.to_lowercase();
    let bytes = lowered.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            let before_ok = i == 0
                || lowered[..i]
                    .chars()
                    .last()
                    .map(|c| c.is_whitespace() || matches!(c, '(' | '[' | '{' | ','))
                    .unwrap_or(true);
            if before_ok {
                let start = i + 1;
                if start >= bytes.len() || !bytes[start].is_ascii_alphabetic() {
                    i += 1;
                    continue;
                }
                let mut end = start;
                while end < bytes.len() {
                    let c = bytes[end] as char;
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                        end += 1;
                    } else {
                        break;
                    }
                }
                if end > start {
                    let tag = &lowered[start..end];
                    if !is_css_hex_literal(tag) && !out.iter().any(|existing| existing == tag) {
                        out.push(tag.to_string());
                    }
                    i = end;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

pub(crate) fn is_css_hex_literal(tag: &str) -> bool {
    let bytes = tag.as_bytes();
    if !bytes.iter().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    if tag.len() >= 6 {
        return true;
    }
    tag.len() == 3 && bytes.windows(2).all(|w| w[0] == w[1])
}

/// Build an FTS5 MATCH expression from raw user input. Splits on whitespace,
/// strips characters that have meaning in FTS5 syntax, and appends `*` to each
/// surviving token for prefix matching. Returns None when nothing useful
/// remains (callers should treat that as "no results").
fn build_fts_query(input: &str) -> Option<String> {
    let mut tokens = Vec::new();
    for raw in input.split_whitespace() {
        let cleaned: String = raw
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if cleaned.is_empty() {
            continue;
        }
        tokens.push(format!("\"{}\"*", cleaned));
    }
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

fn push_distinct_label(labels: &mut Vec<String>, label: String) {
    if !label.trim().is_empty()
        && !labels
            .iter()
            .any(|existing| labels_match(existing, label.trim()))
    {
        labels.push(label);
    }
}

fn extract_wikilink_labels(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut offset = 0usize;
    while let Some(start_rel) = text[offset..].find("[[") {
        let label_start = offset + start_rel + 2;
        let Some(end_rel) = text[label_start..].find("]]") else {
            break;
        };
        // Index by the resolution target, not the alias (`[[Target|alias]]`).
        let (label, _) = split_wikilink_inner(&text[label_start..label_start + end_rel]);
        if !label.is_empty() && !out.iter().any(|existing| labels_match(existing, label)) {
            out.push(label.to_string());
        }
        offset = label_start + end_rel + 2;
    }
    out
}

fn wikilink_match(text: &str, labels: &[String]) -> Option<(usize, usize)> {
    let mut offset = 0usize;
    while let Some(start_rel) = text[offset..].find("[[") {
        let start = offset + start_rel;
        let label_start = start + 2;
        let end_rel = text[label_start..].find("]]")?;
        let end = label_start + end_rel + 2;
        // Match on the target so aliased links still register as backlinks.
        let (label, _) = split_wikilink_inner(&text[label_start..label_start + end_rel]);
        if labels
            .iter()
            .any(|candidate| labels_match(label, candidate))
        {
            return Some((start, end));
        }
        offset = end;
    }
    None
}

fn wikilink_preview(body: &str, labels: &[String]) -> Option<String> {
    let (start, _) = wikilink_match(body, labels)?;
    let mut snippet_start = start;
    while snippet_start > 0 {
        let prev = body[..snippet_start].chars().next_back()?;
        if matches!(prev, '.' | '!' | '?' | '\n') {
            break;
        }
        snippet_start -= prev.len_utf8();
    }
    let mut snippet_end = start;
    while snippet_end < body.len() {
        let next = body[snippet_end..].chars().next()?;
        snippet_end += next.len_utf8();
        if matches!(next, '.' | '!' | '?' | '\n') {
            break;
        }
    }
    let snippet = strip_wikilinks(body[snippet_start..snippet_end].trim());
    let snippet = collapse_whitespace(&snippet);
    if snippet.is_empty() {
        None
    } else {
        Some(truncate_chars(&snippet, 160))
    }
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_len.saturating_sub(1)).collect();
    out = out.trim_end().to_string();
    out.push('…');
    out
}

/// Subdirs we know how to index. Order is irrelevant for correctness but
/// affects rebuild log readability.
#[derive(Debug, Clone, Copy)]
pub enum Kind {
    Task,
    Event,
    Daily,
    Note,
    Person,
    Resource,
    Area,
    AgentChat,
    Mail,
    TableRow,
}

const ALL_KINDS: &[Kind] = &[
    Kind::Task,
    Kind::Event,
    Kind::Daily,
    Kind::Note,
    Kind::Person,
    Kind::Resource,
    Kind::Area,
    Kind::AgentChat,
];

impl Kind {
    fn subdir(self) -> &'static str {
        match self {
            Kind::Task => "tasks",
            Kind::Event => crate::vault::CADENCE_DIR,
            // After the daily-into-cadence merge, daily files live
            // alongside events in cadence/. Both kinds resolve to the
            // same subdir; rebuild_from_vault relies on the file-level
            // classify in doc_from_path to disambiguate.
            Kind::Daily => crate::vault::CADENCE_DIR,
            Kind::Note => "notebook",
            Kind::Person => "people",
            Kind::Resource => crate::vault::RESOURCES_DIR,
            Kind::Area => crate::vault::AREAS_DIR,
            Kind::AgentChat => crate::vault::AGENT_DIR,
            Kind::Mail => "inbox",
            Kind::TableRow => "tables",
        }
    }

    fn from_subdir(s: &str) -> Option<Kind> {
        match s {
            "tasks" => Some(Kind::Task),
            // Accept legacy "calendar" too — vaults migrate at boot but
            // the watcher may fire on a path before the migration runs.
            crate::vault::CADENCE_DIR | crate::vault::LEGACY_CALENDAR_DIR => Some(Kind::Event),
            // Legacy pre-merger daily/ folder, kept as a read-fallback
            // for un-migrated vaults.
            "daily" => Some(Kind::Daily),
            "notebook" => Some(Kind::Note),
            "people" => Some(Kind::Person),
            crate::vault::RESOURCES_DIR => Some(Kind::Resource),
            crate::vault::AREAS_DIR => Some(Kind::Area),
            crate::vault::AGENT_DIR => Some(Kind::AgentChat),
            "inbox" | "sent" | "archive" => Some(Kind::Mail),
            _ => None,
        }
    }
}

/// Identify the kind of a vault-relative path, if any. Used by the watcher
/// router to decide whether a change is index-relevant.
pub fn classify_relative(rel_path: &str) -> Option<Kind> {
    let mut parts = rel_path.split('/');
    let first = parts.next()?;
    // Cadence files split by filename: a date-shaped basename
    // (`YYYY-MM-DD.md`) is a daily journal with inline events;
    // anything else (rare; legacy event files) is an event.
    if first == crate::vault::CADENCE_DIR || first == crate::vault::LEGACY_CALENDAR_DIR {
        let filename = parts.next()?;
        let stem = filename.strip_suffix(".md").unwrap_or(filename);
        if chrono::NaiveDate::parse_from_str(stem, "%Y-%m-%d").is_ok() {
            return Some(Kind::Daily);
        }
        return Some(Kind::Event);
    }
    if first == "tables" {
        let _table_id = parts.next()?;
        let filename = parts.next()?;
        if filename == "_schema.md" || !filename.ends_with(".md") {
            return None;
        }
        return Some(Kind::TableRow);
    }
    Kind::from_subdir(first)
}

/// Read a single file from disk and project it into an IndexedDoc. Returns
/// Ok(None) for files that don't parse (so we skip them silently in batch
/// rebuild) — call sites that *expect* a parseable file should treat that as
/// an error themselves.
fn doc_from_path(vault_root: &Path, abs_path: &Path) -> Result<Option<IndexedDoc>> {
    let rel = match abs_path.strip_prefix(vault_root) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let rel_str = rel.to_string_lossy().to_string();
    let kind = match classify_relative(&rel_str) {
        Some(k) => k,
        None => return Ok(None),
    };
    let updated_at = file_mtime_ms(abs_path);
    if matches!(kind, Kind::Mail) {
        return Ok(mail::load_email_from_path(abs_path)
            .map(|email| project_email(&email, &rel_str, updated_at)));
    }
    let content = crate::vault::read_record(abs_path)?;
    let doc = match kind {
        Kind::Task => parsers::parse_task(&content)
            .ok()
            .map(|t| project_task(&t, &rel_str, updated_at)),
        Kind::Event => parsers::parse_event(&content)
            .ok()
            .map(|e| project_event(&e, &rel_str, updated_at)),
        Kind::Daily => parsers::parse_daily(&content)
            .ok()
            .map(|d| project_daily(&d, &rel_str, updated_at)),
        Kind::Note => parsers::parse_note(&content)
            .ok()
            .map(|n| project_note(&n, &rel_str, updated_at)),
        Kind::Person => parsers::parse_person(&content)
            .ok()
            .map(|p| project_person(&p, &rel_str, updated_at)),
        Kind::Resource => parsers::parse_resource(&content)
            .ok()
            .map(|b| project_resource(&b, &rel_str, updated_at)),
        Kind::Area => parsers::parse_area(&content)
            .ok()
            .map(|a| project_area(&a, &rel_str, updated_at)),
        Kind::AgentChat => agent::parse_chat(&content, &rel_str)
            .ok()
            .map(|c| project_agent_chat(&c, &rel_str, updated_at)),
        Kind::Mail => unreachable!("mail handled before opening generic record content"),
        Kind::TableRow => parsers::parse_row(&content)
            .ok()
            .map(|r| project_row(&r, &rel_str, updated_at)),
    };
    Ok(doc)
}

fn file_mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn project_task(t: &parsers::Task, path: &str, updated_at: i64) -> IndexedDoc {
    let hint_parts: Vec<String> = [match t.status {
        parsers::TaskStatus::Backlog => "backlog",
        parsers::TaskStatus::InProgress => "in-progress",
        parsers::TaskStatus::Done => "done",
    }
    .to_string()]
    .into_iter()
    .chain(t.scheduled.clone())
    .collect();
    let href = match &t.scheduled {
        Some(d) => format!("/cadence/{}/task/{}", d, t.id),
        None => format!("/tables/tasks?focus={}", t.id),
    };
    IndexedDoc {
        kind: "task",
        doc_id: t.id.clone(),
        path: path.to_string(),
        title: strip_wikilinks(&t.content),
        body: t.body.clone(),
        hint: Some(hint_parts.join(" · ")),
        href,
        area: Some(t.area.clone()),
        tags: t.tags.clone(),
        updated_at,
    }
}

fn project_event(e: &parsers::Event, path: &str, updated_at: i64) -> IndexedDoc {
    let tags = if e.provider == Some(parsers::EventProvider::Ical) {
        e.tags.clone()
    } else {
        let mut tags = e.tags.clone();
        tags.push("event".to_string());
        tags
    };
    IndexedDoc {
        kind: "event",
        doc_id: e.id.clone(),
        path: path.to_string(),
        title: strip_wikilinks(&e.title),
        body: e.body.clone(),
        hint: Some(format_event_date_hint(&e.date)),
        href: format!("/cadence/event/{}", e.id),
        area: Some(e.area.clone()),
        tags,
        updated_at,
    }
}

fn project_daily(d: &parsers::DailyJournal, path: &str, updated_at: i64) -> IndexedDoc {
    IndexedDoc {
        kind: "daily",
        doc_id: d.date.clone(),
        path: path.to_string(),
        title: format_daily_title(&d.date),
        body: d.body.clone(),
        hint: Some(d.date.clone()),
        href: format!("/cadence/{}", d.date),
        area: None,
        tags: Vec::new(),
        updated_at,
    }
}

fn project_note(n: &parsers::Note, path: &str, updated_at: i64) -> IndexedDoc {
    let hint = if n.tags.is_empty() {
        None
    } else {
        Some(n.tags.join(" · "))
    };
    IndexedDoc {
        kind: "note",
        doc_id: n.id.clone(),
        path: path.to_string(),
        title: n.title.clone(),
        body: n.body.clone(),
        hint,
        href: format!("/notebook/{}", n.id),
        area: n.area.clone(),
        tags: n.tags.clone(),
        updated_at,
    }
}

fn project_person(p: &parsers::Person, path: &str, updated_at: i64) -> IndexedDoc {
    let hint = match (p.role.is_empty(), p.company.is_empty()) {
        (false, false) => Some(format!("{} · {}", p.role, p.company)),
        (false, true) => Some(p.role.clone()),
        (true, false) => Some(p.company.clone()),
        (true, true) => None,
    };
    // Searchable text beyond the body: email and the free-text relationship
    // note both join the indexed body so "college friend" finds the person.
    let mut body_with_extras = p.body.clone();
    for extra in [&p.email, &p.relationship] {
        if !extra.is_empty() {
            body_with_extras = format!("{}\n{}", body_with_extras, extra);
        }
    }
    IndexedDoc {
        kind: "person",
        doc_id: p.id.clone(),
        path: path.to_string(),
        title: p.name.clone(),
        body: body_with_extras,
        hint,
        href: format!("/people/{}", p.id),
        area: p.area.clone(),
        tags: Vec::new(),
        updated_at,
    }
}

fn project_resource(b: &parsers::Resource, path: &str, updated_at: i64) -> IndexedDoc {
    IndexedDoc {
        kind: "resource",
        doc_id: b.id.clone(),
        path: path.to_string(),
        title: b.title.clone(),
        body: b.body.clone(),
        hint: Some(b.source.clone()),
        href: format!("/resources/{}", b.id),
        area: None,
        tags: b.tags.clone(),
        updated_at,
    }
}

fn project_area(area: &parsers::Area, path: &str, updated_at: i64) -> IndexedDoc {
    IndexedDoc {
        kind: "area",
        doc_id: area.id.clone(),
        path: path.to_string(),
        title: area.name.clone(),
        body: area.body.clone(),
        hint: None,
        href: format!("/areas/{}", area.id),
        // Areas don't have an `area:` field themselves — they ARE the area.
        area: Some(area.id.clone()),
        tags: Vec::new(),
        updated_at,
    }
}

fn project_agent_chat(chat: &agent::AgentChatRecord, path: &str, updated_at: i64) -> IndexedDoc {
    let body = chat
        .messages
        .iter()
        .map(|message| format!("{}: {}", message.role, message.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    IndexedDoc {
        kind: "agent_chat",
        doc_id: chat.id.clone(),
        path: path.to_string(),
        title: strip_wikilinks(&chat.title),
        body,
        hint: Some(format!("{} · {}", chat.agent, chat.model)),
        href: format!("/agent?chat={}", chat.id),
        area: None,
        tags: Vec::new(),
        updated_at,
    }
}

fn project_email(email: &mail::EmailSummary, path: &str, updated_at: i64) -> IndexedDoc {
    let hint = if email.from_email.is_empty() {
        Some(email.from.clone())
    } else {
        Some(format!("{} · {}", email.from, email.from_email))
    };
    let body = [
        email.body.clone(),
        email.preview.clone(),
        email.from.clone(),
        email.from_email.clone(),
        email.mentions.join(" "),
        email.links.join(" "),
    ]
    .into_iter()
    .filter(|part| !part.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    IndexedDoc {
        kind: "mail",
        doc_id: email.id.clone(),
        path: path.to_string(),
        title: strip_wikilinks(&email.subject),
        body,
        hint,
        href: format!("/mail/{}", email.id),
        area: None,
        tags: Vec::new(),
        updated_at,
    }
}

fn project_row(row: &parsers::Row, path: &str, updated_at: i64) -> IndexedDoc {
    let cells_text = row_cells_text(row);
    let title = row_title(row);
    let body = [cells_text, row.body.clone()]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    IndexedDoc {
        kind: "row",
        doc_id: row.id.clone(),
        path: path.to_string(),
        title: strip_wikilinks(&title),
        body,
        hint: Some(row.table.clone()),
        href: format!("/tables/{}/{}", row.table, row.id),
        area: None,
        tags: Vec::new(),
        updated_at,
    }
}

fn row_title(row: &parsers::Row) -> String {
    row.cells
        .values()
        .filter_map(yaml_value_text)
        .find(|value| !value.trim().is_empty())
        .unwrap_or_else(|| row.id.clone())
}

fn row_cells_text(row: &parsers::Row) -> String {
    row.cells
        .values()
        .filter_map(yaml_value_text)
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn yaml_value_text(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::Null => None,
        serde_yaml::Value::Bool(value) => Some(value.to_string()),
        serde_yaml::Value::Number(value) => Some(value.to_string()),
        serde_yaml::Value::String(value) => Some(value.clone()),
        serde_yaml::Value::Sequence(values) => {
            let text = values
                .iter()
                .filter_map(yaml_value_text)
                .collect::<Vec<_>>()
                .join(", ");
            (!text.is_empty()).then_some(text)
        }
        serde_yaml::Value::Mapping(map) => {
            let text = map
                .iter()
                .filter_map(|(key, value)| {
                    Some(format!(
                        "{}: {}",
                        yaml_value_text(key)?,
                        yaml_value_text(value)?
                    ))
                })
                .collect::<Vec<_>>()
                .join(", ");
            (!text.is_empty()).then_some(text)
        }
        serde_yaml::Value::Tagged(tagged) => yaml_value_text(&tagged.value),
    }
}

fn strip_wikilinks(s: &str) -> String {
    // [[foo bar]] → foo bar; [[Target|alias]] → alias (the displayed text).
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else {
            // Unterminated — keep the literal text and stop scanning.
            out.push_str(&rest[start..]);
            return out;
        };
        let (_, display) = split_wikilink_inner(&after[..end]);
        out.push_str(display);
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn format_event_date_hint(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|d| d.format("%b %-d").to_string())
        .unwrap_or_else(|_| iso.to_string())
}

fn format_daily_title(date: &str) -> String {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|d| d.format("%A, %B %-d").to_string())
        .unwrap_or_else(|_| date.to_string())
}

/// Compute a vault-relative path string from an absolute path. Falls back to
/// the absolute path's lossy form when the file is somehow outside the vault
/// (shouldn't happen for files we wrote, but be lenient).
pub fn rel_path_str(vault: &Path, abs: &Path) -> String {
    abs.strip_prefix(vault)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| abs.to_string_lossy().to_string())
}

/// Convenience: build the indexer's persistent path under the OS app-data dir.
/// Tauri provides this via `app.path().app_data_dir()` — kept here so callers
/// can compute it without depending on the Tauri AppHandle directly.
pub fn default_db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("index.db")
}

/// Project a parsed task into an IndexedDoc. Exposed for command callers that
/// already have the parsed struct in hand and don't want to round-trip
/// through the filesystem.
pub fn doc_from_task(task: &parsers::Task, vault_rel_path: &str) -> IndexedDoc {
    project_task(task, vault_rel_path, now_ms())
}

pub fn doc_from_event(event: &parsers::Event, vault_rel_path: &str) -> IndexedDoc {
    project_event(event, vault_rel_path, now_ms())
}

pub fn doc_from_daily(daily: &parsers::DailyJournal, vault_rel_path: &str) -> IndexedDoc {
    project_daily(daily, vault_rel_path, now_ms())
}

pub fn doc_from_note(note: &parsers::Note, vault_rel_path: &str) -> IndexedDoc {
    project_note(note, vault_rel_path, now_ms())
}

pub fn doc_from_person(person: &parsers::Person, vault_rel_path: &str) -> IndexedDoc {
    project_person(person, vault_rel_path, now_ms())
}

pub fn doc_from_resource(resource: &parsers::Resource, vault_rel_path: &str) -> IndexedDoc {
    project_resource(resource, vault_rel_path, now_ms())
}

pub fn doc_from_agent_chat(chat: &agent::AgentChatRecord, vault_rel_path: &str) -> IndexedDoc {
    project_agent_chat(chat, vault_rel_path, now_ms())
}

pub fn doc_from_email(email: &mail::EmailSummary, vault_rel_path: &str) -> IndexedDoc {
    project_email(email, vault_rel_path, now_ms())
}

pub fn doc_from_row(row: &parsers::Row, vault_rel_path: &str) -> IndexedDoc {
    project_row(row, vault_rel_path, now_ms())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tmp_index() -> (TempDir, IndexHandle) {
        let tmp = TempDir::new().unwrap();
        let handle = IndexHandle::open(&tmp.path().join("idx.db")).unwrap();
        (tmp, handle)
    }

    fn doc(kind: &'static str, id: &str, title: &str, body: &str) -> IndexedDoc {
        IndexedDoc {
            kind,
            doc_id: id.to_string(),
            path: format!("{}/{}.md", kind, id),
            title: title.to_string(),
            body: body.to_string(),
            hint: None,
            href: format!("/{}", id),
            area: None,
            tags: Vec::new(),
            updated_at: 0,
        }
    }

    #[test]
    fn upsert_and_search_returns_match() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("task", "t1", "Ship pricing rewrite", "details"))
            .unwrap();
        let hits = idx.search("pricing", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Ship pricing rewrite");
    }

    #[test]
    fn upsert_replaces_by_path() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("task", "t1", "Old title", "")).unwrap();
        idx.upsert(&doc("task", "t1", "New title", "")).unwrap();
        assert_eq!(idx.document_count().unwrap(), 1);
        let hits = idx.search("title", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "New title");
    }

    #[test]
    fn delete_by_path_removes_record() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("task", "t1", "Buy milk", "")).unwrap();
        idx.delete_by_path("task/t1.md").unwrap();
        assert!(idx.search("milk", 10).unwrap().is_empty());
    }

    #[test]
    fn normalized_tag_index_tracks_explicit_inline_and_delete() {
        let (_tmp, idx) = tmp_index();
        let mut note = doc("note", "n1", "Launch notes", "Ship this as #Open-Source.");
        note.tags = vec!["Roadmap".to_string(), "roadmap".to_string()];
        idx.upsert(&note).unwrap();

        assert_eq!(idx.tagged_paths("#ROADMAP").unwrap().len(), 1);
        assert_eq!(idx.tagged_paths("open-source").unwrap().len(), 1);
        assert!(idx.tagged_paths("ffffff").unwrap().is_empty());

        let counts = idx.tag_counts().unwrap();
        assert!(counts.contains(&("roadmap".to_string(), 1)));
        assert!(counts.contains(&("open-source".to_string(), 1)));

        idx.delete_by_path("note/n1.md").unwrap();
        assert!(idx.tagged_paths("roadmap").unwrap().is_empty());
    }

    #[test]
    fn sender_authored_mail_hashtags_are_not_indexed_as_tags() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("mail", "m1", "Sale", "Use #promo with color #ffffff"))
            .unwrap();
        assert!(idx.tag_counts().unwrap().is_empty());
    }

    #[test]
    fn search_supports_prefix_matching() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("note", "n1", "Pricing strategy doc", ""))
            .unwrap();
        let hits = idx.search("pric", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn backlinks_for_target_match_title_and_id_wikilinks() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("person", "alex-rivera", "Alex Rivera", ""))
            .unwrap();
        idx.upsert(&doc(
            "note",
            "one-on-one",
            "1:1 follow-up",
            "Ask [[Alex Rivera]] about the ingestion pipeline.",
        ))
        .unwrap();
        idx.upsert(&doc(
            "task",
            "draft-rfc",
            "Draft RFC for [[alex-rivera]]",
            "",
        ))
        .unwrap();

        let hits = idx.backlinks_for_target("alex-rivera").unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|hit| hit.title == "1:1 follow-up"
            && hit.preview.as_deref() == Some("Ask Alex Rivera about the ingestion pipeline.")));
        assert!(hits
            .iter()
            .any(|hit| hit.title == "Draft RFC for alex-rivera"));
    }

    #[test]
    fn backlinks_for_target_match_aliased_wikilinks() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("resource", "writer-builders", "Writer-Builders", ""))
            .unwrap();
        idx.upsert(&doc(
            "note",
            "self-label",
            "Self label",
            "If I were to label myself, I'm a [[Writer-Builders|writer-builder]].",
        ))
        .unwrap();

        let hits = idx.backlinks_for_target("writer-builders").unwrap();
        assert_eq!(hits.len(), 1);
        // The preview strips the link to its displayed alias, not the target.
        assert_eq!(
            hits[0].preview.as_deref(),
            Some("If I were to label myself, I'm a writer-builder.")
        );
    }

    #[test]
    fn backlinks_for_target_ignore_plain_text_mentions() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("person", "alex-rivera", "Alex Rivera", ""))
            .unwrap();
        idx.upsert(&doc(
            "note",
            "plain-mention",
            "Plain mention",
            "Alex Rivera is written here, but not as a wikilink.",
        ))
        .unwrap();

        assert!(idx.backlinks_for_target("alex-rivera").unwrap().is_empty());
    }

    #[test]
    fn search_combines_terms_with_implicit_and() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("note", "n1", "Pricing strategy", ""))
            .unwrap();
        idx.upsert(&doc("note", "n2", "Pricing tactics", ""))
            .unwrap();
        // Both contain "pricing"; only n1 contains "strategy".
        let hits = idx.search("pricing strategy", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].doc_id, "n1");
    }

    #[test]
    fn search_returns_empty_for_blank_query() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("task", "t1", "x", "")).unwrap();
        assert!(idx.search("", 10).unwrap().is_empty());
        assert!(idx.search("   ", 10).unwrap().is_empty());
    }

    #[test]
    fn search_strips_special_chars_and_still_matches() {
        let (_tmp, idx) = tmp_index();
        idx.upsert(&doc("task", "t1", "Quarterly planning", ""))
            .unwrap();
        // FTS5 special chars (parens, quotes) get stripped before MATCH.
        let hits = idx.search("(plan)", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn build_fts_query_handles_punctuation_only() {
        assert!(build_fts_query("...").is_none());
    }

    #[test]
    fn classify_relative_recognizes_subdirs() {
        assert!(matches!(classify_relative("tasks/x.md"), Some(Kind::Task)));
        assert!(matches!(
            classify_relative("cadence/x.md"),
            Some(Kind::Event)
        ));
        assert!(matches!(
            classify_relative("daily/2026-04-25.md"),
            Some(Kind::Daily)
        ));
        assert!(matches!(
            classify_relative("resources/x.md"),
            Some(Kind::Resource)
        ));
        assert!(matches!(
            classify_relative("inbox/hello.md"),
            Some(Kind::Mail)
        ));
        assert!(matches!(
            classify_relative("sent/reply.md"),
            Some(Kind::Mail)
        ));
        assert!(matches!(
            classify_relative("archive/old.md"),
            Some(Kind::Mail)
        ));
        assert!(matches!(
            classify_relative("agent/chat.md"),
            Some(Kind::AgentChat)
        ));
        assert!(matches!(
            classify_relative("tables/budget/row_001.md"),
            Some(Kind::TableRow)
        ));
        assert!(classify_relative("tables/budget/_schema.md").is_none());
        // `agents/` (plural) is the retired MCP-era dir and stays unindexed;
        // only the singular `agent/` chat dir is recognized.
        assert!(classify_relative("agents/x.md").is_none());
        assert!(classify_relative("misc/x.md").is_none());
    }

    #[test]
    fn classify_relative_accepts_legacy_subdirs() {
        // Pre-rename vaults still pass classify before boot migration completes.
        assert!(matches!(
            classify_relative("calendar/x.md"),
            Some(Kind::Event)
        ));
        assert!(matches!(
            classify_relative("resources/x.md"),
            Some(Kind::Resource)
        ));
    }

    #[test]
    fn rebuild_from_vault_picks_up_files() {
        use crate::parsers;
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        std::fs::create_dir_all(vault.join("tasks")).unwrap();
        std::fs::create_dir_all(vault.join("notebook")).unwrap();

        let task = parsers::Task {
            id: "t_001".to_string(),
            content: "alpha task".to_string(),
            status: parsers::TaskStatus::Backlog,
            area: "woodshed".to_string(),
            created: None,
            scheduled: None,
            tags: vec![],
            time_spent_seconds: None,
            in_progress_started_at: None,
            sort_key: None,
            body: String::new(),
        };
        std::fs::write(
            vault.join("tasks").join("t_001.md"),
            parsers::serialize_task(&task).unwrap(),
        )
        .unwrap();

        let note = parsers::Note {
            id: "beta-note".to_string(),
            title: "beta brainstorm".to_string(),
            area: Some("personal".to_string()),
            created: "2026-04-25T10:00:00".to_string(),
            tags: vec![],
            favorite: false,
            body: "ideas".to_string(),
        };
        std::fs::write(
            vault.join("notebook").join("beta-note.md"),
            parsers::serialize_note(&note).unwrap(),
        )
        .unwrap();

        // Throw a corrupt file in to make sure it gets skipped without aborting.
        std::fs::write(vault.join("tasks").join("garbage.md"), "not frontmatter").unwrap();

        let idx = IndexHandle::open(&tmp.path().join("idx.db")).unwrap();
        let count = idx.rebuild_from_vault(vault).unwrap();
        assert_eq!(count, 2);
        assert_eq!(idx.search("alpha", 10).unwrap().len(), 1);
        assert_eq!(idx.search("brainstorm", 10).unwrap().len(), 1);
    }

    #[test]
    fn rebuild_from_vault_indexes_mail_and_table_rows() {
        use crate::commands::mail;
        use crate::parsers;
        use std::collections::BTreeMap;

        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        std::fs::create_dir_all(vault.join("inbox")).unwrap();
        std::fs::create_dir_all(vault.join("tables").join("budget")).unwrap();

        let email = mail::EmailSummary {
            id: "msg-1".to_string(),
            thread_id: "thread-1".to_string(),
            from: "Alex Example".to_string(),
            from_email: "alex@example.com".to_string(),
            subject: "Acme launch notes".to_string(),
            body: "Follow up with [[Sam Chen]].".to_string(),
            html: None,
            preview: "Follow up".to_string(),
            date: "2026-06-07T10:00:00Z".to_string(),
            read: false,
            labels: vec!["unread".to_string()],
            mentions: vec![],
            links: vec![],
            inbox: "gmail_alex".to_string(),
            path: String::new(),
            attachments: vec![],
        };
        std::fs::write(
            vault.join("inbox").join("acme-launch.md"),
            mail::render_email_md(&email),
        )
        .unwrap();
        let mut older_email = email.clone();
        older_email.id = "msg-2".to_string();
        older_email.thread_id = "thread-2".to_string();
        older_email.from = "Other Sender".to_string();
        older_email.from_email = "other@example.com".to_string();
        older_email.subject = "Older message".to_string();
        older_email.body = "A separate thread".to_string();
        older_email.date = "2026-06-06T10:00:00Z".to_string();
        std::fs::write(
            vault.join("inbox").join("older.md"),
            mail::render_email_md(&older_email),
        )
        .unwrap();

        let mut cells = BTreeMap::new();
        cells.insert(
            "col_name".to_string(),
            serde_yaml::Value::String("Coffee budget".to_string()),
        );
        let row = parsers::Row {
            id: "row_001".to_string(),
            table: "budget".to_string(),
            created: "2026-04-27T10:05:00".to_string(),
            cells,
            body: "Related to [[Acme launch notes]].".to_string(),
        };
        std::fs::write(
            vault.join("tables").join("budget").join("row_001.md"),
            parsers::serialize_row(&row).unwrap(),
        )
        .unwrap();

        let idx = IndexHandle::open(&tmp.path().join("idx.db")).unwrap();
        let count = idx.rebuild_from_vault(vault).unwrap();
        assert_eq!(count, 3);
        assert_eq!(idx.search("alex", 10).unwrap().len(), 1);
        assert_eq!(idx.search("coffee", 10).unwrap().len(), 1);

        let (first_page, next) = idx.mail_inbox_page(0, 1).unwrap();
        assert_eq!(first_page.len(), 1);
        assert_eq!(first_page[0].id, "msg-1");
        assert_eq!(next, Some(1));
        let (second_page, next) = idx.mail_inbox_page(next.unwrap(), 1).unwrap();
        assert_eq!(second_page[0].id, "msg-2");
        assert_eq!(next, None);
        assert_eq!(
            idx.mail_thread_paths("thread-1").unwrap(),
            vec!["inbox/acme-launch.md"]
        );

        let outgoing = idx.outgoing_links_for_source("row_001").unwrap();
        assert_eq!(outgoing.len(), 1);
        assert!(outgoing[0].resolved);
        assert_eq!(outgoing[0].type_.as_deref(), Some("mail"));
    }

    #[test]
    fn refresh_path_removes_when_file_missing() {
        let (tmp, idx) = tmp_index();
        let vault = tmp.path();
        std::fs::create_dir_all(vault.join("tasks")).unwrap();
        idx.upsert(&doc("task", "t1", "Hello", "")).unwrap();
        // Path on the IndexedDoc above is "task/t1.md" (singular). Match it.
        idx.refresh_path(vault, &vault.join("task").join("t1.md"))
            .unwrap();
        // File doesn't exist → entry should be gone.
        assert_eq!(idx.document_count().unwrap(), 0);
    }
}
