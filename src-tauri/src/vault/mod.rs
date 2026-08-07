// Vault: filesystem operations against ~/woodshed/.
//
// Files are the source of truth. write_atomic uses temp+rename for crash safety,
// with a direct-write fallback when the path is inside iCloud Drive (rename
// across the iCloud sync boundary is not reliable).

mod migration;

pub use migration::migrate_legacy_folders;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use ulid::Ulid;

// Canonical vault subdirectory names. These match the user-facing surface
// names in the app (Cadence, Resources, Areas, etc.). The "calendar"
// folder was renamed to "cadence" in May 2026; the legacy name is still
// accepted on read via the helper below and migrated at boot.
pub const CADENCE_DIR: &str = "cadence";
pub const RESOURCES_DIR: &str = "resources";
/// Areas were JSON-only (`data/areas.json`) until May 2026; now they're
/// file-per-area in `areas/<id>.md`. Legacy JSON read-fallback in
/// `commands/areas` stays for un-migrated vaults.
pub const AREAS_DIR: &str = "areas";
/// Events get a dedicated directory in May 2026. Vault-local events used
/// to live inline in `cadence/<date>.md` frontmatter; they now live one
/// per file at `events/<id>.md` so each event has a markdown body the
/// user can write meeting notes into. iCal events still live in the
/// gcal-cache (canonical metadata); their notes get attached files at
/// `events/ical-<account>-<sha256(uid)[:12]>.md`, created on first save.
pub const EVENTS_DIR: &str = "events";
/// Agent chats are first-class vault records. Each conversation is stored as
/// `agent/<id>.md` with `type: agent_chat` frontmatter and a markdown
/// transcript body so assistant work remains part of the user's second brain.
pub const AGENT_DIR: &str = "agent";
pub const LEGACY_CALENDAR_DIR: &str = "calendar";
/// Legacy daily folder. Daily journal files now live under cadence/
/// alongside their events; legacy vaults migrate at boot.
pub const LEGACY_DAILY_DIR: &str = "daily";
/// Imported Markdown folders keep their existing tree untouched. Woodshed's
/// typed records live in this visible child so an existing `tasks/`, `people/`,
/// or other coincidentally-named folder is never reinterpreted as app data.
pub const IMPORTED_RECORDS_DIR: &str = "woodshed";
const IMPORTED_LAYOUT_MARKER: &str = "imported-layout";

pub const VAULT_SUBDIRS: &[&str] = &[
    "tasks",
    CADENCE_DIR,
    EVENTS_DIR,
    "people",
    "inbox",
    "sent",
    "drafts",
    "notebook",
    RESOURCES_DIR,
    AREAS_DIR,
    AGENT_DIR,
    "tables",
    "data",
    "attachments",
];

/// True when `vault_path` is an adopted Markdown tree rather than a native
/// Woodshed vault. The marker contains no private data; its presence is the
/// portable layout contract shared by every command.
pub fn is_imported_layout(vault_path: &Path) -> bool {
    let marker = vault_path.join(".woodshed").join(IMPORTED_LAYOUT_MARKER);
    // Fail closed. Once the app-owned marker exists, an unreadable or
    // malformed payload must never make Woodshed reinterpret the adopted
    // folder's root as managed collections. The marker is written atomically;
    // any directory entry at that exact path is the durable layout contract.
    // A dangling symlink or other damaged entry is still evidence that this
    // root was adopted, and must never make us migrate the surrounding tree.
    match std::fs::symlink_metadata(&marker) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Root containing Woodshed-managed collections. Native vaults use the vault
/// root itself; adopted Markdown trees use `<vault_root>/woodshed/`.
pub fn records_root(vault_path: &Path) -> PathBuf {
    if is_imported_layout(vault_path) {
        vault_path.join(IMPORTED_RECORDS_DIR)
    } else {
        vault_path.to_path_buf()
    }
}

pub fn collection_dir(vault_path: &Path, subdir: &str) -> PathBuf {
    records_root(vault_path).join(subdir)
}

/// Whether a path belongs to user-authored Markdown outside Woodshed's managed
/// subtree in an adopted folder. This is lexical so removed watcher paths can
/// still be classified after the file no longer exists.
pub fn is_external_content_path(vault_path: &Path, path: &Path) -> bool {
    is_imported_layout(vault_path)
        && path.starts_with(vault_path)
        && !path.starts_with(records_root(vault_path))
        && !path.starts_with(vault_path.join(".woodshed"))
}

/// Collect Markdown beneath one or more real roots without following
/// symlinks. Exclusions are exact root paths; a nested folder that merely has
/// the same name remains ordinary user content.
pub(crate) fn collect_markdown_files_bounded(
    roots: Vec<PathBuf>,
    excluded_roots: &[PathBuf],
) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut stack = roots.clone();
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if roots.contains(&dir) => return Err(error.to_string()),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 50_000 {
                return Err("vault contains too many entries to scan safely".to_string());
            }
            let path = entry.path();
            if excluded_roots.contains(&path)
                || entry.file_name().to_string_lossy().starts_with('.')
            {
                continue;
            }
            if is_real_directory(&path) {
                stack.push(path);
            } else if is_real_file(&path)
                && path.extension().and_then(|value| value.to_str()) == Some("md")
            {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

/// Collect existing Markdown from an adopted folder without following
/// symlinks or entering app-managed/internal trees.
pub fn collect_external_markdown_files(vault_path: &Path) -> Result<Vec<PathBuf>, String> {
    if !is_imported_layout(vault_path) {
        return Ok(Vec::new());
    }
    collect_markdown_files_bounded(
        vec![vault_path.to_path_buf()],
        &[records_root(vault_path), vault_path.join(".woodshed")],
    )
}

/// Mark an existing Markdown folder as an imported-layout vault without
/// moving or rewriting any user-authored file.
pub fn initialize_imported_layout(vault_path: &Path) -> Result<()> {
    if !is_real_directory(vault_path) {
        anyhow::bail!(
            "import root must be a real directory: {}",
            vault_path.display()
        );
    }

    let managed = vault_path.join(IMPORTED_RECORDS_DIR);
    if managed.exists() && !is_real_directory(&managed) {
        anyhow::bail!(
            "reserved managed-record path is not a real directory: {}",
            managed.display()
        );
    }
    if is_real_directory(&managed) {
        let occupied = std::fs::read_dir(&managed)
            .with_context(|| format!("inspect managed-record directory {}", managed.display()))?
            .next()
            .transpose()?
            .is_some();
        if occupied && !is_imported_layout(vault_path) {
            anyhow::bail!(
                "{} already contains a non-empty '{}' folder; rename that folder before importing so Woodshed never claims existing files",
                vault_path.display(),
                IMPORTED_RECORDS_DIR
            );
        }
    }

    let internal = vault_path.join(".woodshed");
    std::fs::create_dir_all(&internal)
        .with_context(|| format!("create internal directory {}", internal.display()))?;
    if !is_real_directory(&internal) {
        anyhow::bail!(
            "Woodshed internal path must be a real directory: {}",
            internal.display()
        );
    }
    let marker = internal.join(IMPORTED_LAYOUT_MARKER);
    match std::fs::symlink_metadata(&marker) {
        Ok(metadata) if !metadata.is_file() => {
            anyhow::bail!(
                "import layout marker must be a regular file: {}",
                marker.display()
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("inspect import marker {}", marker.display()));
        }
    }
    write_atomic(&marker, &format!("{IMPORTED_RECORDS_DIR}\n"))
        .with_context(|| format!("write imported layout marker {}", marker.display()))?;
    ensure_dirs(vault_path)
}

pub fn ensure_dirs(vault_path: &Path) -> Result<()> {
    std::fs::create_dir_all(vault_path)
        .with_context(|| format!("create vault root at {}", vault_path.display()))?;
    if is_imported_layout(vault_path) {
        let marker = vault_path.join(".woodshed").join(IMPORTED_LAYOUT_MARKER);
        let metadata = std::fs::symlink_metadata(&marker)
            .with_context(|| format!("inspect imported-layout marker {}", marker.display()))?;
        if !metadata.is_file() {
            anyhow::bail!(
                "imported-layout marker must be a regular file: {}",
                marker.display()
            );
        }
    }
    let records_root = records_root(vault_path);
    std::fs::create_dir_all(&records_root)
        .with_context(|| format!("create managed records root {}", records_root.display()))?;
    if !is_real_directory(&records_root) {
        anyhow::bail!(
            "managed records root must be a real directory: {}",
            records_root.display()
        );
    }
    for sub in VAULT_SUBDIRS {
        let p = records_root.join(sub);
        std::fs::create_dir_all(&p)
            .with_context(|| format!("create vault subdir {}", p.display()))?;
        let metadata = std::fs::symlink_metadata(&p)
            .with_context(|| format!("inspect vault subdir {}", p.display()))?;
        if !metadata.is_dir() {
            anyhow::bail!("vault subdir must be a real directory: {}", p.display());
        }
    }
    Ok(())
}

/// Returns the live cadence directory: prefers `cadence/`, falls back to
/// legacy `calendar/` if cadence/ doesn't exist but calendar/ does.
/// Boot migration normally ensures the new path exists, so this only
/// matters for vaults restored from backup or with failed migrations.
pub fn cadence_dir(vault: &Path) -> PathBuf {
    let records = records_root(vault);
    let new = records.join(CADENCE_DIR);
    if is_real_directory(&new) {
        return new;
    }
    let legacy = records.join(LEGACY_CALENDAR_DIR);
    if is_real_directory(&legacy) {
        return legacy;
    }
    new
}

pub fn resources_dir(vault: &Path) -> PathBuf {
    collection_dir(vault, RESOURCES_DIR)
}

/// Returns the areas directory. Unlike the other rename helpers there's
/// no legacy folder fallback — areas used to be a JSON file, not a
/// directory. Un-migrated vaults are handled by the JSON read-fallback
/// in `commands::areas`.
pub fn areas_dir(vault: &Path) -> PathBuf {
    collection_dir(vault, AREAS_DIR)
}

/// Returns the events directory. Unlike cadence/resources there's
/// no legacy folder fallback — events used to live inline in daily
/// frontmatter, not a directory. The boot migrator lifts them out into
/// per-file shape; un-migrated vaults still surface inline events via
/// the cadence-file read-fallback in `commands::events`.
pub fn events_dir(vault: &Path) -> PathBuf {
    collection_dir(vault, EVENTS_DIR)
}

pub fn agent_dir(vault: &Path) -> PathBuf {
    collection_dir(vault, AGENT_DIR)
}

/// Validate a record identifier before it becomes a filesystem component.
/// IDs may contain Unicode, spaces, dots, `@`, and other ordinary filename
/// characters, but never path syntax, hidden-file prefixes, or controls.
pub fn validate_record_id(id: &str) -> std::result::Result<(), String> {
    if id.is_empty() {
        return Err("record id cannot be empty".to_string());
    }
    if id == "." || id == ".." || id.starts_with('.') {
        return Err("record id cannot be a dot path or hidden filename".to_string());
    }
    if id.contains('/') || id.contains('\\') {
        return Err("record id cannot contain path separators".to_string());
    }
    if id.chars().any(char::is_control) {
        return Err("record id cannot contain control characters".to_string());
    }
    if id.len() > 200 {
        return Err("record id cannot exceed 200 UTF-8 bytes".to_string());
    }
    Ok(())
}

pub fn validate_daily_date(date: &str) -> std::result::Result<(), String> {
    let parsed = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| "date must be a valid YYYY-MM-DD calendar date".to_string())?;
    if parsed.format("%Y-%m-%d").to_string() != date {
        return Err("date must use zero-padded YYYY-MM-DD format".to_string());
    }
    Ok(())
}

/// Directory scans must not follow a vault entry that is actually a symlink.
/// A linked markdown file could otherwise make ordinary list/search commands
/// read and surface arbitrary files elsewhere on the machine.
pub fn is_real_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

/// Directory counterpart to [`is_real_file`]. `Path::is_dir` follows links;
/// this helper deliberately does not.
pub fn is_real_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

pub const MAX_RECORD_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_FRONTMATTER_BYTES: u64 = 256 * 1024;
const MAX_REVISIONS_PER_RECORD: usize = 50;

fn open_regular_file(path: &Path) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options
        .open(path)
        .with_context(|| format!("open vault record {}", path.display()))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("inspect open vault record {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("vault record must be a regular file: {}", path.display());
    }
    Ok(file)
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<String> {
    let mut file = open_regular_file(path)?;
    let metadata = file
        .metadata()
        .with_context(|| format!("inspect open vault record {}", path.display()))?;
    if metadata.len() > max_bytes {
        anyhow::bail!("vault record exceeds byte limit: {}", path.display());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read vault record {}", path.display()))?;
    if bytes.len() as u64 > max_bytes {
        anyhow::bail!("vault record exceeds byte limit: {}", path.display());
    }
    String::from_utf8(bytes).with_context(|| format!("decode vault record {}", path.display()))
}

/// Read a vault text record with the same symlink and size policy used by
/// scanners. Binary attachments have their own type-specific limits.
pub fn read_record(path: &Path) -> Result<String> {
    read_bounded(path, MAX_RECORD_BYTES)
}

/// Read only YAML frontmatter from a vault record. This keeps list views from
/// loading multi-megabyte bodies while preserving the same no-follow policy as
/// [`read_record`].
pub fn read_record_frontmatter(path: &Path) -> Result<String> {
    let file = open_regular_file(path)?;
    let mut reader = Read::take(std::io::BufReader::new(file), MAX_FRONTMATTER_BYTES + 1);
    let mut output = String::new();
    let mut line = String::new();
    let mut lines = 0usize;
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .with_context(|| format!("read vault frontmatter {}", path.display()))?;
        if read == 0 {
            anyhow::bail!("vault frontmatter is unterminated: {}", path.display());
        }
        if output.len().saturating_add(read) as u64 > MAX_FRONTMATTER_BYTES {
            anyhow::bail!("vault frontmatter exceeds byte limit: {}", path.display());
        }
        output.push_str(&line);
        lines += 1;
        if lines == 1 && line.trim_end() != "---" {
            anyhow::bail!("vault record has no YAML frontmatter: {}", path.display());
        }
        if lines > 1 && line.trim_end() == "---" {
            return Ok(output);
        }
    }
}

/// Construct an existing-or-new `collection/<id>.md` path and reject any
/// collection or record symlink that resolves outside the configured vault.
pub fn record_file_path(
    vault: &Path,
    collection: &str,
    id: &str,
) -> std::result::Result<PathBuf, String> {
    let (collection_path, _) = confined_collection(vault, collection)?;
    record_file_path_in(vault, &collection_path, id)
}

/// Construct `<directory>/<id>.md` for a nested, already-existing directory
/// such as `tables/<table-id>`, while preserving vault confinement.
pub fn record_file_path_in(
    vault: &Path,
    directory: &Path,
    id: &str,
) -> std::result::Result<PathBuf, String> {
    validate_record_id(id)?;
    let canonical_vault = vault
        .canonicalize()
        .map_err(|e| format!("resolve vault path {}: {e}", vault.display()))?;
    let metadata = std::fs::symlink_metadata(directory)
        .map_err(|e| format!("resolve record directory {}: {e}", directory.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "record directory must be a real directory: {}",
            directory.display()
        ));
    }
    let canonical_directory = directory
        .canonicalize()
        .map_err(|e| format!("resolve record directory {}: {e}", directory.display()))?;
    if !canonical_directory.starts_with(&canonical_vault) {
        return Err(format!(
            "record directory escapes configured vault: {}",
            directory.display()
        ));
    }
    let path = directory.join(format!("{id}.md"));
    validate_existing_child(&path, &canonical_directory, false)?;
    Ok(path)
}

/// Construct an existing-or-new `collection/<id>/` path with the same
/// confinement rules as `record_file_path`.
pub fn record_directory_path(
    vault: &Path,
    collection: &str,
    id: &str,
) -> std::result::Result<PathBuf, String> {
    validate_record_id(id)?;
    let (collection_path, canonical_collection) = confined_collection(vault, collection)?;
    let path = collection_path.join(id);
    validate_existing_child(&path, &canonical_collection, true)?;
    Ok(path)
}

fn confined_collection(
    vault: &Path,
    collection: &str,
) -> std::result::Result<(PathBuf, PathBuf), String> {
    validate_record_id(collection)?;
    let canonical_vault = vault
        .canonicalize()
        .map_err(|e| format!("resolve vault path {}: {e}", vault.display()))?;
    let collection_path = collection_dir(vault, collection);
    let metadata = std::fs::symlink_metadata(&collection_path).map_err(|e| {
        format!(
            "inspect vault collection {}: {e}",
            collection_path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "vault collection must be a real directory: {}",
            collection_path.display()
        ));
    }
    let canonical_collection = collection_path.canonicalize().map_err(|e| {
        format!(
            "resolve vault collection {}: {e}",
            collection_path.display()
        )
    })?;
    if !canonical_collection.starts_with(&canonical_vault) {
        return Err(format!(
            "vault collection escapes configured vault: {}",
            collection_path.display()
        ));
    }
    Ok((collection_path, canonical_collection))
}

/// Create or validate a nested directory beneath the vault one component at a
/// time. Existing symlinks are rejected before descending into them.
pub fn ensure_vault_directory(
    vault: &Path,
    components: &[&str],
) -> std::result::Result<PathBuf, String> {
    let canonical_vault = vault
        .canonicalize()
        .map_err(|e| format!("resolve vault path {}: {e}", vault.display()))?;
    ensure_directory_components(&records_root(vault), components, &canonical_vault)
}

fn ensure_directory_components(
    root: &Path,
    components: &[&str],
    canonical_boundary: &Path,
) -> std::result::Result<PathBuf, String> {
    let mut directory = root.to_path_buf();
    for component in components {
        validate_record_id(component)?;
        directory.push(component);
        match std::fs::symlink_metadata(&directory) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "vault directory must be a real directory: {}",
                        directory.display()
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&directory)
                    .map_err(|e| format!("create vault directory {}: {e}", directory.display()))?;
            }
            Err(error) => {
                return Err(format!(
                    "inspect vault directory {}: {error}",
                    directory.display()
                ));
            }
        }
        let canonical = directory
            .canonicalize()
            .map_err(|e| format!("resolve vault directory {}: {e}", directory.display()))?;
        if !canonical.starts_with(canonical_boundary) {
            return Err(format!(
                "vault directory escapes configured vault: {}",
                directory.display()
            ));
        }
    }
    Ok(directory)
}

/// True when `path` canonicalizes to a real file inside the canonicalized
/// `vault`, compared component-wise. Fail-closed: any canonicalize error
/// (missing file, symlink loop, permissions, NUL bytes) yields false, so
/// IPC-supplied paths can never drive a read outside the vault.
pub fn path_confined_to_vault(vault: &Path, path: &Path) -> bool {
    let Ok(canon_vault) = vault.canonicalize() else {
        return false;
    };
    let Ok(canon_path) = path.canonicalize() else {
        return false;
    };
    canon_path.starts_with(&canon_vault)
}

/// Construct a single regular-file child beneath an already validated vault
/// directory without following a pre-existing symlink at the destination.
pub fn confined_file_path(
    vault: &Path,
    directory: &Path,
    filename: &str,
) -> std::result::Result<PathBuf, String> {
    validate_record_id(filename)?;
    let canonical_vault = vault
        .canonicalize()
        .map_err(|e| format!("resolve vault path {}: {e}", vault.display()))?;
    let metadata = std::fs::symlink_metadata(directory)
        .map_err(|e| format!("inspect vault directory {}: {e}", directory.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "vault directory must be a real directory: {}",
            directory.display()
        ));
    }
    let canonical_directory = directory
        .canonicalize()
        .map_err(|e| format!("resolve vault directory {}: {e}", directory.display()))?;
    if !canonical_directory.starts_with(&canonical_vault) {
        return Err(format!(
            "vault directory escapes configured vault: {}",
            directory.display()
        ));
    }
    let path = directory.join(filename);
    validate_existing_child(&path, &canonical_directory, false)?;
    Ok(path)
}

fn validate_existing_child(
    path: &Path,
    canonical_parent: &Path,
    expect_directory: bool,
) -> std::result::Result<(), String> {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "record path cannot be a symlink: {}",
            path.display()
        ));
    }
    if expect_directory != metadata.is_dir() {
        return Err(format!(
            "record path has the wrong type: {}",
            path.display()
        ));
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("resolve record path {}: {e}", path.display()))?;
    if canonical.parent() != Some(canonical_parent) {
        return Err(format!(
            "record path escapes its collection: {}",
            path.display()
        ));
    }
    Ok(())
}

/// Move a vault record into a per-operation trash directory instead of
/// unlinking it. The original vault-relative path is preserved beneath
/// `.woodshed/trash/<ulid>/`, making recovery a plain filesystem move.
pub fn move_to_trash(vault: &Path, source: &Path) -> std::result::Result<Option<PathBuf>, String> {
    let Ok(metadata) = std::fs::symlink_metadata(source) else {
        return Ok(None);
    };
    if metadata.file_type().is_symlink() {
        return Err(format!("refusing to trash a symlink: {}", source.display()));
    }
    let canonical_vault = vault
        .canonicalize()
        .map_err(|e| format!("resolve vault path {}: {e}", vault.display()))?;
    let canonical_source = source
        .canonicalize()
        .map_err(|e| format!("resolve record path {}: {e}", source.display()))?;
    if !canonical_source.starts_with(&canonical_vault) {
        return Err(format!(
            "record path escapes configured vault: {}",
            source.display()
        ));
    }
    let relative = source
        .strip_prefix(vault)
        .map_err(|_| format!("record path is not beneath vault: {}", source.display()))?;
    if path_is_inside_revisions(relative) {
        return Err("refusing to trash Woodshed internal state".to_string());
    }
    let trash_root = ensure_internal_directory(vault, "trash").map_err(|e| e.to_string())?;
    let destination = trash_root
        .join(Ulid::new().to_string().to_ascii_lowercase())
        .join(relative);
    let parent = destination
        .parent()
        .ok_or_else(|| "trash destination has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create trash directory {}: {e}", parent.display()))?;
    std::fs::rename(source, &destination).map_err(|e| {
        format!(
            "move {} to trash {}: {e}",
            source.display(),
            destination.display()
        )
    })?;
    Ok(Some(destination))
}

pub fn write_atomic(path: &Path, content: &str) -> Result<()> {
    if content.len() as u64 > MAX_RECORD_BYTES {
        anyhow::bail!(
            "vault record exceeds {} MiB: {}",
            MAX_RECORD_BYTES / 1024 / 1024,
            path.display()
        );
    }
    snapshot_existing_file(path, Some(content))?;
    write_binary_atomic(path, content.as_bytes())
}

/// Atomically persist bounded binary content. Callers enforce their
/// type-specific byte limit before invoking this helper.
pub fn write_binary_atomic(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("ensure parent dir {}", parent.display()))?;
    if !is_real_directory(parent) {
        anyhow::bail!(
            "write parent must be a real directory: {}",
            parent.display()
        );
    }
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            anyhow::bail!("refusing to replace non-regular file {}", path.display());
        }
    }

    if is_icloud_path(path) {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut file = options
            .open(path)
            .with_context(|| format!("open direct-write iCloud path {}", path.display()))?;
        file.write_all(content)
            .with_context(|| format!("write iCloud path {}", path.display()))?;
        return file
            .sync_all()
            .with_context(|| format!("sync iCloud path {}", path.display()));
    }

    let temp_path = parent.join(format!(
        ".woodshed-{}.tmp",
        Ulid::new().to_string().to_ascii_lowercase()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut temp = options
        .open(&temp_path)
        .with_context(|| format!("create temp file {}", temp_path.display()))?;
    if let Err(error) = temp.write_all(content).and_then(|_| temp.sync_all()) {
        drop(temp);
        let _ = std::fs::remove_file(&temp_path);
        return Err(error).with_context(|| format!("write temp file {}", temp_path.display()));
    }
    drop(temp);

    if let Err(e) = std::fs::rename(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(e)
            .with_context(|| format!("rename {} to {}", temp_path.display(), path.display()));
    }
    Ok(())
}

pub fn snapshot_existing_file(path: &Path, next_content: Option<&str>) -> Result<()> {
    if !is_real_file(path) || path_is_inside_revisions(path) {
        return Ok(());
    }
    let Some((vault_root, rel_path)) = vault_root_and_rel_path(path) else {
        return Ok(());
    };
    let previous = read_record(path)?;
    if next_content.is_some_and(|next| next == previous) {
        return Ok(());
    }
    let hash = content_revision(&previous);
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let revisions_root = ensure_internal_directory(&vault_root, "revisions")?;
    let canonical_revisions_root = revisions_root
        .canonicalize()
        .with_context(|| format!("resolve revisions root {}", revisions_root.display()))?;
    let component_strings = rel_path
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => value
                .to_str()
                .map(str::to_string)
                .ok_or_else(|| anyhow::anyhow!("revision path is not valid UTF-8")),
            _ => Err(anyhow::anyhow!(
                "revision path contains a non-normal component"
            )),
        })
        .collect::<Result<Vec<_>>>()?;
    let component_refs = component_strings
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let snapshot_dir =
        ensure_directory_components(&revisions_root, &component_refs, &canonical_revisions_root)
            .map_err(anyhow::Error::msg)?;
    let snapshot_path = snapshot_dir.join(format!("{}-{}.md", stamp, &hash[..12]));
    write_binary_atomic(&snapshot_path, previous.as_bytes())
        .with_context(|| format!("write revision snapshot {}", snapshot_path.display()))?;
    prune_revision_directory(&snapshot_dir, MAX_REVISIONS_PER_RECORD)?;
    Ok(())
}

fn prune_revision_directory(directory: &Path, retain: usize) -> Result<()> {
    let mut revisions = std::fs::read_dir(directory)
        .with_context(|| format!("read revision directory {}", directory.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(OsStr::to_str) == Some("md") && is_real_file(path))
        .collect::<Vec<_>>();
    revisions.sort();
    let remove_count = revisions.len().saturating_sub(retain);
    for path in revisions.into_iter().take(remove_count) {
        std::fs::remove_file(&path)
            .with_context(|| format!("prune old revision {}", path.display()))?;
    }
    Ok(())
}

fn ensure_internal_directory(vault: &Path, name: &str) -> Result<PathBuf> {
    validate_record_id(name).map_err(anyhow::Error::msg)?;
    let internal = vault.join(".woodshed");
    std::fs::create_dir_all(&internal)
        .with_context(|| format!("create internal directory {}", internal.display()))?;
    if !is_real_directory(&internal) {
        anyhow::bail!(
            "Woodshed internal path must be a real directory: {}",
            internal.display()
        );
    }
    let directory = internal.join(name);
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("create internal directory {}", directory.display()))?;
    if !is_real_directory(&directory) {
        anyhow::bail!(
            "Woodshed internal path must be a real directory: {}",
            directory.display()
        );
    }
    Ok(directory)
}

pub fn content_revision(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex_lower(&hasher.finalize())
}

fn vault_root_and_rel_path(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut ancestor = path.parent();
    while let Some(dir) = ancestor {
        // Existing Markdown in an adopted folder sits outside the canonical
        // collection tree, so the portable import marker is its only safe
        // vault-root boundary. This gives external notes the same recoverable
        // revision history as Woodshed-managed records.
        if is_imported_layout(dir) {
            let rel = path.strip_prefix(dir).ok()?.to_path_buf();
            return Some((dir.to_path_buf(), rel));
        }
        let name = dir.file_name().and_then(OsStr::to_str);
        if name.is_some_and(|name| VAULT_SUBDIRS.contains(&name)) {
            let collection_root = dir.parent()?;
            let root = if collection_root.file_name() == Some(OsStr::new(IMPORTED_RECORDS_DIR)) {
                let candidate = collection_root.parent()?;
                if is_imported_layout(candidate) {
                    candidate.to_path_buf()
                } else {
                    collection_root.to_path_buf()
                }
            } else {
                collection_root.to_path_buf()
            };
            let rel = path.strip_prefix(&root).ok()?.to_path_buf();
            return Some((root, rel));
        }
        ancestor = dir.parent();
    }
    None
}

fn path_is_inside_revisions(path: &Path) -> bool {
    path.components().any(|component| match component {
        std::path::Component::Normal(part) => part == OsStr::new(".woodshed"),
        _ => false,
    })
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn is_icloud_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.contains("/Library/Mobile Documents/") || s.contains("/iCloud~")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn path_confined_to_vault_accepts_in_vault_files() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("woodshed");
        ensure_dirs(&vault).unwrap();
        let person = vault.join("people").join("alex.md");
        std::fs::write(&person, "x").unwrap();
        assert!(path_confined_to_vault(&vault, &person));
    }

    #[test]
    fn path_confined_to_vault_rejects_dotdot_and_absolute_escapes() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("woodshed");
        ensure_dirs(&vault).unwrap();
        // `..` segment resolving outside the vault.
        let escape = vault.join("people").join("..").join("..").join("secret.md");
        std::fs::create_dir_all(escape.parent().unwrap()).unwrap();
        std::fs::write(&escape, "x").unwrap();
        assert!(!path_confined_to_vault(&vault, &escape));
        // Absolute path outside the vault entirely.
        let outside = tmp.path().join("outside.md");
        std::fs::write(&outside, "x").unwrap();
        assert!(!path_confined_to_vault(&vault, &outside));
    }

    #[test]
    fn path_confined_to_vault_rejects_symlink_out_of_vault_and_missing_files() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("woodshed");
        ensure_dirs(&vault).unwrap();
        let outside = tmp.path().join("outside.md");
        std::fs::write(&outside, "x").unwrap();
        let link = vault.join("people").join("linked.md");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        // A symlinked person file pointing outside the vault is rejected.
        assert!(!path_confined_to_vault(&vault, &link));
        // Missing files fail closed.
        assert!(!path_confined_to_vault(
            &vault,
            &vault.join("people").join("ghost.md")
        ));
    }

    #[test]
    fn ensure_dirs_creates_all_subdirs() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("woodshed");
        ensure_dirs(&vault).unwrap();
        for sub in VAULT_SUBDIRS {
            assert!(vault.join(sub).is_dir(), "missing subdir {}", sub);
        }
    }

    #[test]
    fn ensure_dirs_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("woodshed");
        ensure_dirs(&vault).unwrap();
        std::fs::write(vault.join("tasks").join("existing.md"), "x").unwrap();
        ensure_dirs(&vault).unwrap();
        assert!(vault.join("tasks").join("existing.md").exists());
    }

    #[test]
    fn imported_layout_scaffolds_managed_records_without_touching_existing_files() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("existing-notes");
        std::fs::create_dir_all(vault.join("Projects")).unwrap();
        std::fs::write(vault.join("Projects/plan.md"), "# Existing plan\n").unwrap();

        initialize_imported_layout(&vault).unwrap();

        assert!(is_imported_layout(&vault));
        assert_eq!(
            std::fs::read_to_string(vault.join("Projects/plan.md")).unwrap(),
            "# Existing plan\n"
        );
        for sub in VAULT_SUBDIRS {
            assert!(vault.join(IMPORTED_RECORDS_DIR).join(sub).is_dir());
            assert!(!vault.join(sub).exists());
        }
    }

    #[test]
    fn imported_layout_refuses_to_claim_an_existing_managed_folder() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("existing-notes");
        std::fs::create_dir_all(vault.join(IMPORTED_RECORDS_DIR)).unwrap();
        std::fs::write(vault.join(IMPORTED_RECORDS_DIR).join("mine.md"), "keep").unwrap();

        let error = initialize_imported_layout(&vault).unwrap_err().to_string();

        assert!(error.contains("never claims existing files"));
        assert!(!vault.join(".woodshed/imported-layout").exists());
        assert_eq!(
            std::fs::read_to_string(vault.join(IMPORTED_RECORDS_DIR).join("mine.md")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn malformed_import_marker_fails_closed_into_the_managed_subtree() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("existing-notes");
        std::fs::create_dir_all(vault.join(".woodshed")).unwrap();
        std::fs::write(vault.join(".woodshed/imported-layout"), "incomplete").unwrap();
        std::fs::create_dir_all(vault.join("tasks")).unwrap();
        std::fs::write(vault.join("tasks/existing.md"), "# Existing\n").unwrap();

        assert!(is_imported_layout(&vault));
        ensure_dirs(&vault).unwrap();
        assert!(vault.join("woodshed/tasks").is_dir());
        assert_eq!(
            std::fs::read_to_string(vault.join("tasks/existing.md")).unwrap(),
            "# Existing\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_import_marker_still_fails_closed() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("existing-notes");
        std::fs::create_dir_all(vault.join(".woodshed")).unwrap();
        symlink(
            tmp.path().join("missing-marker-target"),
            vault.join(".woodshed/imported-layout"),
        )
        .unwrap();

        assert!(is_imported_layout(&vault));
        assert_eq!(records_root(&vault), vault.join("woodshed"));
        assert!(ensure_dirs(&vault)
            .unwrap_err()
            .to_string()
            .contains("must be a regular file"));
        assert!(!vault.join("tasks").exists());
    }

    #[cfg(unix)]
    #[test]
    fn external_markdown_scan_skips_symlinks_and_managed_records() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("existing-notes");
        std::fs::create_dir_all(vault.join("Projects")).unwrap();
        let external = vault.join("Projects/plan.md");
        std::fs::write(&external, "# Plan\n").unwrap();
        let outside = tmp.path().join("outside.md");
        std::fs::write(&outside, "# Outside\n").unwrap();
        symlink(&outside, vault.join("Projects/linked.md")).unwrap();
        initialize_imported_layout(&vault).unwrap();
        std::fs::write(vault.join("woodshed/notebook/managed.md"), "managed").unwrap();

        assert_eq!(
            collect_external_markdown_files(&vault).unwrap(),
            vec![external]
        );
    }

    #[test]
    fn imported_file_edits_create_recoverable_revisions_at_the_vault_root() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("existing-notes");
        std::fs::create_dir_all(vault.join("Projects")).unwrap();
        let note = vault.join("Projects/plan.md");
        std::fs::write(&note, "Original content").unwrap();
        initialize_imported_layout(&vault).unwrap();

        write_atomic(&note, "Updated content").unwrap();

        let revision_dir = vault.join(".woodshed/revisions/Projects/plan.md");
        let revisions = std::fs::read_dir(revision_dir)
            .unwrap()
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(revisions.len(), 1);
        assert_eq!(
            std::fs::read_to_string(revisions[0].path()).unwrap(),
            "Original content"
        );
    }

    #[test]
    fn ensure_dirs_does_not_scaffold_or_delete_retired_sweep_data() {
        let tmp = TempDir::new().unwrap();
        let fresh = tmp.path().join("fresh");
        ensure_dirs(&fresh).unwrap();
        assert!(!fresh.join("sweep").exists());

        let existing = tmp.path().join("existing");
        std::fs::create_dir_all(existing.join("sweep")).unwrap();
        std::fs::write(existing.join("sweep").join("card.md"), "preserve me").unwrap();
        ensure_dirs(&existing).unwrap();
        assert_eq!(
            std::fs::read_to_string(existing.join("sweep").join("card.md")).unwrap(),
            "preserve me"
        );
    }

    #[cfg(unix)]
    #[test]
    fn ensure_dirs_rejects_symlinked_collections() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("woodshed");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, vault.join("tasks")).unwrap();
        assert!(ensure_dirs(&vault).is_err());
    }

    #[test]
    fn record_id_accepts_one_safe_path_component() {
        for id in ["t_01HM3X9Y", "alex-rivera", "row.001", "café"] {
            assert!(validate_record_id(id).is_ok(), "expected safe id: {id}");
        }
    }

    #[test]
    fn record_id_rejects_path_syntax_and_controls() {
        for id in [
            "",
            ".",
            "..",
            ".hidden",
            "../../etc/passwd",
            "/tmp/record",
            "folder/record",
            "folder\\record",
            "line\nbreak",
            "nul\0byte",
        ] {
            assert!(
                validate_record_id(id).is_err(),
                "expected unsafe id: {id:?}"
            );
        }
        assert!(validate_record_id(&"a".repeat(201)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn bounded_record_reader_rejects_symlinks_and_oversized_files() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let real = tmp.path().join("real.md");
        std::fs::write(&real, "secret").unwrap();
        let linked = tmp.path().join("linked.md");
        symlink(&real, &linked).unwrap();
        assert!(read_record(&linked).is_err());

        let oversized = tmp.path().join("oversized.md");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_RECORD_BYTES + 1).unwrap();
        assert!(read_record(&oversized).is_err());
    }

    #[test]
    fn frontmatter_reader_does_not_load_the_record_body() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("mail.md");
        let content = format!("---\nid: example\n---\n\n{}", "body".repeat(100_000));
        std::fs::write(&path, content).unwrap();
        assert_eq!(
            read_record_frontmatter(&path).unwrap(),
            "---\nid: example\n---\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn nested_vault_directories_reject_symlink_components() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("vault");
        let outside = tmp.path().join("outside");
        ensure_dirs(&vault).unwrap();
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, vault.join("attachments").join("mail")).unwrap();
        assert!(ensure_vault_directory(&vault, &["attachments", "mail", "message"]).is_err());
    }

    #[test]
    fn daily_date_requires_exact_iso_calendar_date() {
        assert!(validate_daily_date("2026-07-26").is_ok());
        for date in ["2026-7-26", "2026-02-30", "../2026-07-26", ""] {
            assert!(
                validate_daily_date(date).is_err(),
                "expected invalid date: {date}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn record_file_rejects_a_symlink_that_escapes_the_vault() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("vault");
        let outside = tmp.path().join("outside.md");
        ensure_dirs(&vault).unwrap();
        std::fs::write(&outside, "secret").unwrap();
        symlink(&outside, vault.join("people").join("alex.md")).unwrap();

        assert!(record_file_path(&vault, "people", "alex").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn record_directory_rejects_a_symlink_that_escapes_the_vault() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("vault");
        let outside = tmp.path().join("outside");
        ensure_dirs(&vault).unwrap();
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, vault.join("tables").join("budget")).unwrap();

        assert!(record_directory_path(&vault, "tables", "budget").is_err());
    }

    #[test]
    fn move_to_trash_is_recoverable_and_preserves_relative_path() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("vault");
        ensure_dirs(&vault).unwrap();
        let source = record_file_path(&vault, "people", "alex").unwrap();
        std::fs::write(&source, "person").unwrap();

        let trashed = move_to_trash(&vault, &source).unwrap().unwrap();

        assert!(!source.exists());
        assert_eq!(std::fs::read_to_string(&trashed).unwrap(), "person");
        assert!(trashed
            .strip_prefix(&vault)
            .unwrap()
            .to_string_lossy()
            .contains(".woodshed/trash/"));
        assert!(trashed.ends_with("people/alex.md"));
    }

    #[test]
    fn write_atomic_writes_and_replaces() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("foo.md");
        write_atomic(&target, "hello").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello");
        write_atomic(&target, "goodbye").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "goodbye");
    }

    #[test]
    fn write_atomic_creates_parent_dirs() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("nested").join("dir").join("foo.md");
        write_atomic(&target, "hello").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello");
    }

    #[test]
    fn write_atomic_leaves_no_temp_file() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("foo.md");
        write_atomic(&target, "x").unwrap();
        let entries: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1, "expected exactly the target file");
    }

    #[test]
    fn write_atomic_rejects_oversized_records() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("too-large.md");
        let content = "x".repeat(MAX_RECORD_BYTES as usize + 1);
        assert!(write_atomic(&target, &content).is_err());
        assert!(!target.exists());
    }

    #[test]
    fn write_atomic_snapshots_previous_vault_file() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("woodshed");
        std::fs::create_dir_all(vault.join("notebook")).unwrap();
        let target = vault.join("notebook").join("foo.md");
        std::fs::write(&target, "before").unwrap();

        write_atomic(&target, "after").unwrap();

        assert_eq!(std::fs::read_to_string(&target).unwrap(), "after");
        let snapshot_dir = vault
            .join(".woodshed")
            .join("revisions")
            .join("notebook")
            .join("foo.md");
        let snapshots: Vec<_> = std::fs::read_dir(snapshot_dir).unwrap().flatten().collect();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(
            std::fs::read_to_string(snapshots[0].path()).unwrap(),
            "before"
        );
    }

    #[test]
    fn revision_retention_prunes_oldest_snapshots() {
        let tmp = TempDir::new().unwrap();
        for index in 0..52 {
            std::fs::write(tmp.path().join(format!("{index:03}.md")), index.to_string()).unwrap();
        }
        prune_revision_directory(tmp.path(), MAX_REVISIONS_PER_RECORD).unwrap();
        let remaining = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(remaining, MAX_REVISIONS_PER_RECORD);
        assert!(!tmp.path().join("000.md").exists());
        assert!(!tmp.path().join("001.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn revision_snapshot_rejects_nested_symlink_directories() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().join("woodshed");
        std::fs::create_dir_all(vault.join("notebook")).unwrap();
        let target = vault.join("notebook").join("foo.md");
        std::fs::write(&target, "before").unwrap();
        let revisions = vault.join(".woodshed").join("revisions");
        std::fs::create_dir_all(&revisions).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, revisions.join("notebook")).unwrap();

        assert!(write_atomic(&target, "after").is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "before");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn is_icloud_path_detects_mobile_documents() {
        assert!(is_icloud_path(Path::new(
            "/Users/foo/Library/Mobile Documents/com~apple~CloudDocs/woodshed"
        )));
    }

    #[test]
    fn is_icloud_path_rejects_normal_home_dir() {
        assert!(!is_icloud_path(Path::new("/Users/foo/woodshed")));
        assert!(!is_icloud_path(Path::new("/Users/foo/Documents/woodshed")));
    }

    #[test]
    fn cadence_dir_prefers_new_when_present() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::create_dir_all(vault.join(CADENCE_DIR)).unwrap();
        std::fs::create_dir_all(vault.join(LEGACY_CALENDAR_DIR)).unwrap();
        assert_eq!(cadence_dir(&vault), vault.join(CADENCE_DIR));
    }

    #[test]
    fn cadence_dir_falls_back_to_legacy_when_new_missing() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        std::fs::create_dir_all(vault.join(LEGACY_CALENDAR_DIR)).unwrap();
        assert_eq!(cadence_dir(&vault), vault.join(LEGACY_CALENDAR_DIR));
    }

    #[test]
    fn cadence_dir_returns_new_when_neither_exists() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        assert_eq!(cadence_dir(&vault), vault.join(CADENCE_DIR));
    }

    #[test]
    fn resources_dir_returns_canonical_path() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        assert_eq!(resources_dir(&vault), vault.join(RESOURCES_DIR));
    }
}
