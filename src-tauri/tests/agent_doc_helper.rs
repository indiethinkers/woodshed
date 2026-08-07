use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn app_binary_extracts_document_text_through_the_private_helper_protocol() {
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_woodshed"))
        .arg("--woodshed-agent-doc-extract")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn Woodshed document helper");

    child
        .stdin
        .take()
        .expect("open helper stdin")
        .write_all(include_bytes!("fixtures/synthetic.pdf"))
        .expect("send synthetic PDF");

    let output = child.wait_with_output().expect("wait for document helper");
    assert!(
        output.status.success(),
        "helper failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(started.elapsed() < Duration::from_secs(5));

    let response: Value = serde_json::from_slice(&output.stdout).expect("parse helper response");
    if response["status"] != "ok" {
        panic!("helper error: {:?}", response["message"]);
    }
    assert_eq!(response["status"], "ok");
    let text = response["text"].as_str().expect("helper text field");
    assert!(
        text.contains("Synthetic PDF attachment for Woodshed regression testing."),
        "unexpected helper text: {text:?}"
    );
}
