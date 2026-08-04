// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = woodshed_lib::commands::agent::run_pdf_helper_if_requested() {
        std::process::exit(exit_code);
    }
    woodshed_lib::run();
}
