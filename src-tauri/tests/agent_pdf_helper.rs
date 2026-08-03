#![cfg(target_os = "macos")]

use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn app_binary_extracts_pdf_text_through_the_private_helper_protocol() {
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_woodshed"))
        .arg("--woodshed-agent-pdf-extract")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn Woodshed PDF helper");

    child
        .stdin
        .take()
        .expect("open helper stdin")
        .write_all(include_bytes!("fixtures/synthetic.pdf"))
        .expect("send synthetic PDF");

    let output = child.wait_with_output().expect("wait for PDF helper");
    assert!(
        output.status.success(),
        "helper failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(started.elapsed() < Duration::from_secs(5));

    let response: Value = serde_json::from_slice(&output.stdout).expect("parse helper response");
    assert_eq!(response["status"], "ok");
    assert_eq!(
        response["text"],
        "Synthetic PDF attachment for Woodshed regression testing."
    );
}
