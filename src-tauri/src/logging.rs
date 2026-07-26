// Simple append-only log file under <app_data_dir>/woodshed.log.
//
// Why not the `log` or `tracing` crate? Because the use case is
// narrow — we just want a trail for postmortem debugging of crashes
// in `pnpm tauri dev` and end-user reports. A pure stderr trail
// disappears the moment the user closes the terminal; this also
// writes to disk so they can grep it later. ~40 lines beats pulling
// in a logging-framework dependency.
//
// Mirrors a unified shape:
//   2026-05-10T16:30:42Z  INFO   gcal::sync  sync_all start (1 accounts)
//   2026-05-10T16:30:43Z  ERROR  gcal::sync  fetch failed: …
//
// Every log line also goes to stderr so the dev terminal stays
// informative. The file is bounded — a soft rotate at 1 MiB keeps
// it from growing without bound on a long-running user vault.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 1_048_576; // 1 MiB
const LOG_FILENAME: &str = "woodshed.log";

#[derive(Debug, Clone, Copy)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Info => "INFO ",
            Level::Warn => "WARN ",
            Level::Error => "ERROR",
        }
    }
}

/// Resolved log path. Set once on `init`; thereafter every `log()`
/// call writes to the same file. `OnceLock` means we don't need to
/// thread the AppHandle through every call site that wants to log.
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
/// Serializes writes so two threads logging concurrently don't
/// interleave bytes mid-line.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Resolve the log path under app_data_dir and stamp a session-start
/// banner. Called once from `lib::run` after Tauri is set up.
pub fn init(app_data_dir: &Path) {
    let path = app_data_dir.join(LOG_FILENAME);
    let _ = LOG_PATH.set(path.clone());
    let _ = fs::create_dir_all(app_data_dir);
    log_to_path(&path, Level::Info, "logging", "session start");
    install_panic_hook();
}

/// Route Rust panics into `woodshed.log` (in addition to stderr).
///
/// Without this, a panic — and the lock-poisoning storm that follows when it
/// fires while a shared `Mutex`/`RwLock` is held — goes *only* to the
/// `tauri dev` stderr, which vanishes the moment the dev server restarts. The
/// vault appears to "stop loading" (every `.lock().unwrap()` on the poisoned
/// lock now panics too) with zero trail on disk. Capturing the panic here is
/// what makes that failure mode diagnosable after the fact.
///
/// The hook chains to the previous one (the default stderr printer) so the
/// dev terminal still shows the panic. It is deliberately allocation-light and
/// never `unwrap`s, so it can't double-panic (which would abort the process).
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("unnamed");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        // `PanicHookInfo::payload` is most often `&str` or `String`.
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(|s| s.as_str()))
            .unwrap_or("<non-string panic payload>");
        let backtrace = std::backtrace::Backtrace::force_capture();
        log(
            Level::Error,
            "panic",
            format!("thread '{thread_name}' panicked at {location}: {message}\n{backtrace}"),
        );
        // Preserve the default behavior (stderr print / abort wiring).
        previous(info);
    }));
}

/// Log a line. Cheap and infallible: if writing fails the message
/// still goes to stderr so the dev terminal sees it.
pub fn log(level: Level, target: &str, msg: impl AsRef<str>) {
    let msg = msg.as_ref();
    if let Some(path) = LOG_PATH.get() {
        log_to_path(path, level, target, msg);
    } else {
        eprintln!("[{}] {target}: {msg}", level.label().trim());
    }
}

fn log_to_path(path: &Path, level: Level, target: &str, msg: &str) {
    let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    let line = format!("{ts}  {}  {target}  {msg}\n", level.label());
    // stderr always — visible in `pnpm tauri dev`.
    eprint!("{line}");

    let _guard = WRITE_LOCK.lock();
    let _ = maybe_rotate(path);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn maybe_rotate(path: &Path) -> std::io::Result<()> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    if meta.len() < MAX_BYTES {
        return Ok(());
    }
    // Single-generation rotation: <name>.log.old. The previous .old
    // is overwritten — enough to debug the most recent session
    // without growing on disk forever.
    let mut old = path.to_path_buf();
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(LOG_FILENAME);
    old.set_file_name(format!("{filename}.old"));
    let _ = fs::remove_file(&old);
    fs::rename(path, &old)
}

/// Convenience macros so call sites read like `log_info!("gcal::sync", "x")`.
#[macro_export]
macro_rules! log_info {
    ($target:expr, $($arg:tt)*) => {
        $crate::logging::log($crate::logging::Level::Info, $target, format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($target:expr, $($arg:tt)*) => {
        $crate::logging::log($crate::logging::Level::Warn, $target, format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_error {
    ($target:expr, $($arg:tt)*) => {
        $crate::logging::log($crate::logging::Level::Error, $target, format!($($arg)*))
    };
}

/// Read the most recent `tail_lines` lines from the log file. Used by
/// the `logs_tail` Tauri command so the UI can surface logs without
/// the user having to dig through the filesystem.
pub fn tail(tail_lines: usize) -> String {
    let Some(path) = LOG_PATH.get() else {
        return String::new();
    };
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(tail_lines);
    lines[start..].join("\n")
}

/// Returns the resolved log path, if `init` has run. Used by a Tauri
/// command that surfaces "open log file" / "copy log path" affordances.
pub fn path() -> Option<PathBuf> {
    LOG_PATH.get().cloned()
}
