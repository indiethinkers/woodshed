// Tauri commands exposing the logging module to the frontend.
//
//   logs_event — JS records an error/warning into the shared log file.
//                Used by tauriInvoke's catch path and by the React error
//                boundaries to write the stack trace to disk.
//   logs_tail  — read the last N lines for in-app log viewers.
//   logs_path  — return the absolute log path so settings can show it
//                / open it in Finder.

use crate::logging::{self, Level};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEventInput {
    pub level: String,
    pub target: String,
    pub message: String,
}

#[tauri::command]
pub fn logs_event(input: LogEventInput) {
    let level = match input.level.to_ascii_lowercase().as_str() {
        "warn" | "warning" => Level::Warn,
        "error" => Level::Error,
        _ => Level::Info,
    };
    logging::log(level, &input.target, &input.message);
}

#[tauri::command]
pub fn logs_tail(lines: Option<usize>) -> String {
    logging::tail(lines.unwrap_or(200))
}

#[tauri::command]
pub fn logs_path() -> String {
    logging::path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn logs_open() -> Result<(), String> {
    let path = logging::path().ok_or_else(|| "Log file is not initialized".to_string())?;
    super::vault::open_path(&path)
}
