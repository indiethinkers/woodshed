// Watcher: debounced filesystem watcher with self-write filter.
//
// The app records its own writes via record_self_write before they hit the FS.
// Watcher events that arrive within SELF_WRITE_WINDOW after a self-write for
// the same path are dropped. This prevents the round-trip storm:
//   write → watcher fires → invalidate → refetch → identical state → flicker.

use crate::sync_ext::MutexRecover;
use anyhow::{Context, Result};
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEBOUNCE_INTERVAL: Duration = Duration::from_millis(150);
const SELF_WRITE_WINDOW: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultChange {
    Modified(PathBuf),
    Removed(PathBuf),
}

type SelfWrites = Arc<Mutex<HashMap<PathBuf, Instant>>>;

pub struct VaultWatcher {
    _debouncer: Debouncer<notify::RecommendedWatcher>,
    self_writes: SelfWrites,
    /// Shared "vault generation" counter. `None` until `watcher_start`
    /// attaches the `AppState`'s counter via `set_vault_generation`.
    /// Once set, `record_self_write` (the single chokepoint every
    /// command's write funnels through) bumps it so derived caches keyed
    /// on the generation (e.g. `tag_table` / `tags_with_counts`)
    /// invalidate without waiting for the watcher round-trip. External
    /// edits bump the same counter from the watcher callback in
    /// `watcher_start`. The `AppState` holds a clone of this `Arc`, so
    /// both sides observe one counter.
    ///
    /// Attached post-construction (rather than as a `start` argument) so
    /// the watcher's constructor signature stays stable for every caller.
    vault_generation: Mutex<Option<Arc<AtomicU64>>>,
}

impl VaultWatcher {
    pub fn start<F>(vault_path: &Path, callback: F) -> Result<Self>
    where
        F: Fn(Vec<VaultChange>) + Send + 'static,
    {
        let canonical_root = vault_path
            .canonicalize()
            .with_context(|| format!("canonicalize vault path {}", vault_path.display()))?;

        let self_writes: SelfWrites = Arc::new(Mutex::new(HashMap::new()));
        let cb_self_writes = self_writes.clone();

        let mut debouncer = new_debouncer(DEBOUNCE_INTERVAL, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let now = Instant::now();

            let mut sw = cb_self_writes.lock_recover();
            sw.retain(|_, t| now.duration_since(*t) < SELF_WRITE_WINDOW);

            let mut seen = HashSet::new();
            let changes: Vec<VaultChange> = events
                .into_iter()
                .flat_map(|ev| changes_for_event_path(&ev.path, &sw))
                .filter(|change| {
                    let path = match change {
                        VaultChange::Modified(path) | VaultChange::Removed(path) => path,
                    };
                    seen.insert(path.clone())
                })
                .collect();

            if !changes.is_empty() {
                callback(changes);
            }
        })
        .context("create debouncer")?;

        debouncer
            .watcher()
            .watch(&canonical_root, RecursiveMode::Recursive)
            .with_context(|| format!("watch vault path {}", canonical_root.display()))?;

        Ok(VaultWatcher {
            _debouncer: debouncer,
            self_writes,
            vault_generation: Mutex::new(None),
        })
    }

    /// Attach the shared vault-generation counter. Called once by
    /// `watcher_start` after the watcher is constructed. Idempotent —
    /// re-attaching simply replaces the handle.
    pub fn set_vault_generation(&self, counter: Arc<AtomicU64>) {
        *self.vault_generation.lock_recover() = Some(counter);
    }

    pub fn record_self_write(&self, path: &Path) {
        let now = Instant::now();
        let mut self_writes = self.self_writes.lock_recover();
        self_writes.insert(canonicalize_for_match(path), now);
        if let Some(temp_path) = atomic_temp_path(path) {
            self_writes.insert(canonicalize_for_match(&temp_path), now);
        }
        // Internal-write chokepoint: every command records its write here
        // before it hits disk, so bumping the generation here invalidates
        // the tag-table memo immediately (no watcher round-trip). External
        // edits bump the same counter from the watcher callback. No-op
        // until watcher_start attaches the counter via set_vault_generation.
        if let Some(gen) = self.vault_generation.lock_recover().as_ref() {
            gen.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn atomic_temp_path(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    let name = path.file_name()?;
    Some(parent.join(format!(".{}.woodshed-tmp", name.to_string_lossy())))
}

/// Canonicalize a path that may not yet exist. Resolves the parent (which
/// must exist) and rejoins the filename. On macOS this strips the
/// `/var` → `/private/var` symlink discrepancy so self-write keys match
/// notify's event paths.
fn canonicalize_for_match(path: &Path) -> PathBuf {
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(canon_parent) = parent.canonicalize() {
            return canon_parent.join(name);
        }
    }
    path.to_path_buf()
}

fn changes_for_event_path(
    path: &Path,
    self_writes: &HashMap<PathBuf, Instant>,
) -> Vec<VaultChange> {
    let canonical = canonicalize_for_match(path);
    if self_writes.contains_key(&canonical) {
        return Vec::new();
    }

    if path.is_dir() {
        return std::fs::read_dir(path)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.filter_map(|entry| entry.ok()))
            .map(|entry| entry.path())
            .filter(|entry_path| {
                entry_path.is_file()
                    && entry_path.extension().and_then(|s| s.to_str()) == Some("md")
                    && !self_writes.contains_key(&canonicalize_for_match(entry_path))
            })
            .map(VaultChange::Modified)
            .collect();
    }

    if path.exists() {
        vec![VaultChange::Modified(path.to_path_buf())]
    } else {
        vec![VaultChange::Removed(path.to_path_buf())]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use tempfile::TempDir;

    #[test]
    fn watcher_fires_on_external_write() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().canonicalize().unwrap();

        let (tx, rx) = mpsc::channel();
        let _watcher = VaultWatcher::start(&vault, move |changes| {
            tx.send(changes).ok();
        })
        .unwrap();

        // Settle the watcher
        std::thread::sleep(Duration::from_millis(100));

        let target = vault.join("hello.md");
        std::fs::write(&target, "hi").unwrap();

        let changes = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            changes.iter().any(
                |c| matches!(c, VaultChange::Modified(p) if p.file_name() == target.file_name())
            ),
            "expected Modified event for hello.md, got {:?}",
            changes
        );
    }

    #[test]
    fn watcher_filters_self_writes() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().canonicalize().unwrap();

        let (tx, rx) = mpsc::channel();
        let watcher = VaultWatcher::start(&vault, move |changes| {
            tx.send(changes).ok();
        })
        .unwrap();
        let generation = Arc::new(AtomicU64::new(0));
        watcher.set_vault_generation(generation.clone());

        std::thread::sleep(Duration::from_millis(100));

        let target = vault.join("self-written.md");
        assert_eq!(generation.load(Ordering::Relaxed), 0);
        watcher.record_self_write(&target);
        // record_self_write is the internal-write chokepoint: it must bump
        // the shared vault generation so the tag-table memo invalidates.
        assert_eq!(generation.load(Ordering::Relaxed), 1);
        std::fs::write(&target, "hi").unwrap();

        // Should NOT receive a change event within the self-write window
        let res = rx.recv_timeout(Duration::from_millis(400));
        assert!(
            res.is_err(),
            "expected no event for self-write, got {:?}",
            res
        );
    }

    #[test]
    fn watcher_filters_atomic_temp_self_writes() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().canonicalize().unwrap();

        let (tx, rx) = mpsc::channel();
        let watcher = VaultWatcher::start(&vault, move |changes| {
            tx.send(changes).ok();
        })
        .unwrap();

        std::thread::sleep(Duration::from_millis(100));

        let target = vault.join("self-written.md");
        let temp_path = atomic_temp_path(&target).unwrap();
        watcher.record_self_write(&target);
        std::fs::write(&temp_path, "hi").unwrap();
        std::fs::rename(&temp_path, &target).unwrap();

        let res = rx.recv_timeout(Duration::from_millis(400));
        assert!(
            res.is_err(),
            "expected no event for atomic self-write, got {:?}",
            res
        );
    }

    #[test]
    fn vault_change_equality() {
        let a = VaultChange::Modified(PathBuf::from("/x"));
        let b = VaultChange::Modified(PathBuf::from("/x"));
        assert_eq!(a, b);
    }
}
