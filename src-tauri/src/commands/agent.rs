use crate::agent::runs::{self, AgentRunCreateInput, AgentRunDto, AgentRunRecord};
use crate::agent::{
    self, AgentChatCreateInput, AgentChatInput, AgentChatRecord, AgentChatStreamEvent,
    AgentChatStreamInput, AgentChatSummary, AgentChatUpdateInput, AgentConfig, AgentConfigInput,
    AgentConnectionTestResult, HermesConfigMeta,
};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";
const AGENT_RUN_EVENT_FLUSH_INTERVAL: Duration = Duration::from_millis(100);
const AGENT_ATTACHMENT_PREPARE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_AGENT_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_AGENT_ATTACHMENT_TEXT_BYTES: usize = 2 * 1024 * 1024;
const MAX_AGENT_PDF_PAGES: usize = 2_000;
const AGENT_PDF_HELPER_ARG: &str = "--woodshed-agent-pdf-extract";
const MAX_AGENT_PDF_HELPER_OUTPUT_BYTES: usize = MAX_AGENT_ATTACHMENT_TEXT_BYTES + 4 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAttachmentPrepareInput {
    pub filename: Option<String>,
    pub media_type: Option<String>,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachmentPrepareResult {
    pub context: String,
}

struct DecodedAgentAttachment {
    label: String,
    media_type: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum AgentPdfHelperResponse {
    Ok { text: String },
    Error { message: String },
}

struct AgentRunProgress {
    response: String,
    pending_events: Vec<agent::AgentStreamEvent>,
}

fn push_coalesced_agent_event(
    events: &mut Vec<agent::AgentStreamEvent>,
    event: agent::AgentStreamEvent,
) {
    if let Some(previous) = events.last_mut() {
        if previous.kind == event.kind && matches!(event.kind.as_str(), "delta" | "reasoning-delta")
        {
            if let (Some(existing), Some(incoming)) =
                (previous.delta.as_mut(), event.delta.as_deref())
            {
                existing.push_str(incoming);
                return;
            }
        }
        if previous.kind == "tool-input-delta"
            && event.kind == "tool-input-delta"
            && previous.tool_call_id == event.tool_call_id
        {
            if let (Some(existing), Some(incoming)) = (
                previous.input_text_delta.as_mut(),
                event.input_text_delta.as_deref(),
            ) {
                existing.push_str(incoming);
                return;
            }
        }
    }
    events.push(event);
}

/// Convert user-selected attachment bytes into bounded text before Hermes sees
/// the message. The agent receives neither the original filesystem path nor a
/// filename-only hint, so it has no reason to probe Desktop, Photos, or Music
/// with Python or another subprocess.
#[tauri::command]
pub async fn agent_attachment_prepare(
    input: AgentAttachmentPrepareInput,
) -> Result<AgentAttachmentPrepareResult, String> {
    let attachment = decode_agent_attachment(input)?;
    let DecodedAgentAttachment {
        label,
        media_type,
        bytes,
    } = attachment;
    let text = if media_type == "application/pdf" {
        extract_pdf_text_isolated(bytes).await?
    } else {
        String::from_utf8(bytes)
            .map_err(|_| "the text attachment is not valid UTF-8".to_string())?
    };
    finish_agent_attachment(label, media_type, text)
}

#[cfg(test)]
fn prepare_agent_attachment_in_process(
    input: AgentAttachmentPrepareInput,
) -> Result<AgentAttachmentPrepareResult, String> {
    let DecodedAgentAttachment {
        label,
        media_type,
        bytes,
    } = decode_agent_attachment(input)?;
    let text = if media_type == "application/pdf" {
        extract_pdf_text(&bytes)?
    } else {
        String::from_utf8(bytes)
            .map_err(|_| "the text attachment is not valid UTF-8".to_string())?
    };
    finish_agent_attachment(label, media_type, text)
}

fn decode_agent_attachment(
    input: AgentAttachmentPrepareInput,
) -> Result<DecodedAgentAttachment, String> {
    let label = safe_attachment_label(input.filename.as_deref());
    let media_type =
        normalized_attachment_media_type(input.media_type.as_deref(), input.filename.as_deref())?;
    let expected_prefix = format!("data:{media_type};base64");
    let (metadata, encoded) = input
        .data_url
        .split_once(',')
        .ok_or_else(|| "attachment data must be a base64 data URL".to_string())?;
    if !metadata.eq_ignore_ascii_case(&expected_prefix) {
        return Err("attachment data URL does not match its media type".to_string());
    }
    let max_encoded = MAX_AGENT_ATTACHMENT_BYTES.div_ceil(3) * 4;
    if encoded.len() > max_encoded {
        return Err(format!(
            "attachment exceeds the {MAX_AGENT_ATTACHMENT_BYTES} byte limit"
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "attachment data is not valid base64".to_string())?;
    if bytes.len() > MAX_AGENT_ATTACHMENT_BYTES {
        return Err(format!(
            "attachment exceeds the {MAX_AGENT_ATTACHMENT_BYTES} byte limit"
        ));
    }
    Ok(DecodedAgentAttachment {
        label,
        media_type,
        bytes,
    })
}

fn finish_agent_attachment(
    label: String,
    media_type: String,
    text: String,
) -> Result<AgentAttachmentPrepareResult, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(
            "This attachment contains no extractable text. Image-only PDFs are not supported yet."
                .to_string(),
        );
    }
    if text.len() > MAX_AGENT_ATTACHMENT_TEXT_BYTES {
        return Err(format!(
            "attachment text exceeds the {MAX_AGENT_ATTACHMENT_TEXT_BYTES} byte limit"
        ));
    }
    Ok(AgentAttachmentPrepareResult {
        context: format!("[Attachment: {label} ({media_type})]\n{text}\n[/Attachment]"),
    })
}

fn safe_attachment_label(filename: Option<&str>) -> String {
    let basename = filename
        .unwrap_or("Attachment")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("Attachment")
        .trim();
    let mut safe = basename
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(160)
        .collect::<String>();
    safe = safe.split_whitespace().collect::<Vec<_>>().join(" ");
    if safe.is_empty() {
        "Attachment".to_string()
    } else {
        safe
    }
}

fn normalized_attachment_media_type(
    media_type: Option<&str>,
    filename: Option<&str>,
) -> Result<String, String> {
    let normalized = media_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let inferred_pdf = filename
        .map(|value| value.to_ascii_lowercase().ends_with(".pdf"))
        .unwrap_or(false);
    if normalized == "application/pdf" || (normalized.is_empty() && inferred_pdf) {
        return Ok("application/pdf".to_string());
    }
    if normalized.starts_with("text/") || normalized == "application/json" {
        return Ok(normalized);
    }
    Err("Woodshed can currently read PDF and text attachments in Agent chats".to_string())
}

#[cfg(target_os = "macos")]
fn extract_pdf_text(bytes: &[u8]) -> Result<String, String> {
    use objc2::rc::autoreleasepool;
    use objc2::AnyThread;
    use objc2_foundation::NSData;
    use objc2_pdf_kit::PDFDocument;

    autoreleasepool(|_| {
        let data = NSData::with_bytes(bytes);
        // SAFETY: PDFKit retains the immutable NSData for the duration of the
        // document. The initializer is failable for malformed input.
        let document = unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) }
            .ok_or_else(|| "Woodshed could not extract text from this PDF".to_string())?;
        // Read page-by-page so the declared text budget is enforced without
        // materializing the complete document string. Do not call
        // `numberOfCharacters` first: PDFKit may perform the same expensive
        // text-layout pass again when `string` is requested.
        let page_count = unsafe { document.pageCount() };
        if page_count > MAX_AGENT_PDF_PAGES {
            return Err(format!("PDF exceeds the {MAX_AGENT_PDF_PAGES} page limit"));
        }
        let mut output = String::new();
        for index in 0..page_count {
            // SAFETY: the index is within `pageCount`; the page accessors are
            // read-only PDFKit properties and objc2 retains returned objects.
            let page = unsafe { document.pageAtIndex(index) }
                .ok_or_else(|| "Woodshed could not read a page from this PDF".to_string())?;
            let page_text = unsafe { page.string() }
                .map(|value| value.to_string())
                .unwrap_or_default();
            append_pdf_page_text(&mut output, &page_text, MAX_AGENT_ATTACHMENT_TEXT_BYTES)?;
        }
        Ok(output)
    })
}

fn append_pdf_page_text(output: &mut String, page_text: &str, limit: usize) -> Result<(), String> {
    let separator_bytes = usize::from(!output.is_empty());
    if output
        .len()
        .saturating_add(separator_bytes)
        .saturating_add(page_text.len())
        > limit
    {
        return Err(format!(
            "attachment text exceeds the {MAX_AGENT_ATTACHMENT_TEXT_BYTES} byte limit"
        ));
    }
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(page_text);
    Ok(())
}

#[cfg(target_os = "macos")]
async fn extract_pdf_text_isolated(bytes: Vec<u8>) -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|_| "Woodshed could not start its PDF reader".to_string())?;
    let mut command = tokio::process::Command::new(executable);
    command.arg(AGENT_PDF_HELPER_ARG);
    let output = run_bounded_helper(
        command,
        bytes,
        AGENT_ATTACHMENT_PREPARE_TIMEOUT,
        MAX_AGENT_PDF_HELPER_OUTPUT_BYTES,
    )
    .await?;
    let response: AgentPdfHelperResponse = serde_json::from_slice(&output)
        .map_err(|_| "Woodshed's PDF reader returned an invalid response".to_string())?;
    match response {
        AgentPdfHelperResponse::Ok { text } => Ok(text),
        AgentPdfHelperResponse::Error { message } => Err(message),
    }
}

#[cfg(not(target_os = "macos"))]
async fn extract_pdf_text_isolated(_bytes: Vec<u8>) -> Result<String, String> {
    Err("PDF attachments are supported by the macOS desktop app".to_string())
}

#[cfg(target_os = "macos")]
async fn run_bounded_helper(
    mut command: tokio::process::Command,
    input: Vec<u8>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<Vec<u8>, String> {
    use std::process::Stdio;

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "Woodshed could not start its PDF reader".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Woodshed could not open its PDF reader input".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Woodshed could not open its PDF reader output".to_string())?;

    let result = tokio::time::timeout(
        timeout,
        exchange_with_pdf_helper(&mut child, stdin, stdout, input, max_output_bytes),
    )
    .await;
    match result {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => {
            terminate_pdf_helper(&mut child).await;
            Err(error)
        }
        Err(_) => {
            terminate_pdf_helper(&mut child).await;
            Err(
                "PDF text extraction timed out. The document may use complex or unsupported text encoding."
                    .to_string(),
            )
        }
    }
}

#[cfg(target_os = "macos")]
async fn exchange_with_pdf_helper(
    child: &mut tokio::process::Child,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    input: Vec<u8>,
    max_output_bytes: usize,
) -> Result<Vec<u8>, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    stdin
        .write_all(&input)
        .await
        .map_err(|_| "Woodshed's PDF reader stopped accepting input".to_string())?;
    // Tokio's Unix `ChildStdin::poll_shutdown` is a no-op. Drop the handle so
    // the helper receives EOF and can leave its bounded `read_to_end` call.
    drop(stdin);
    let mut output = Vec::new();
    stdout
        .take((max_output_bytes + 1) as u64)
        .read_to_end(&mut output)
        .await
        .map_err(|_| "Woodshed could not read extracted PDF text".to_string())?;
    if output.len() > max_output_bytes {
        return Err("Woodshed's PDF reader exceeded its output limit".to_string());
    }
    let status = child
        .wait()
        .await
        .map_err(|_| "Woodshed could not finish its PDF reader".to_string())?;
    if !status.success() {
        return Err("Woodshed's PDF reader stopped unexpectedly".to_string());
    }
    Ok(output)
}

#[cfg(target_os = "macos")]
async fn terminate_pdf_helper(child: &mut tokio::process::Child) {
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill().await;
    }
    let _ = child.wait().await;
}

/// Intercept the private helper mode before Tauri initializes. The helper
/// accepts PDF bytes only over stdin and emits one bounded JSON response; it
/// never receives or opens a filesystem path.
pub fn run_pdf_helper_if_requested() -> Option<i32> {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(AGENT_PDF_HELPER_ARG)) {
        return None;
    }
    let response = (|| -> Result<String, String> {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take((MAX_AGENT_ATTACHMENT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Woodshed could not read the PDF attachment".to_string())?;
        if bytes.len() > MAX_AGENT_ATTACHMENT_BYTES {
            return Err(format!(
                "attachment exceeds the {MAX_AGENT_ATTACHMENT_BYTES} byte limit"
            ));
        }
        extract_pdf_text(&bytes)
    })();
    let response = match response {
        Ok(text) => AgentPdfHelperResponse::Ok { text },
        Err(message) => AgentPdfHelperResponse::Error { message },
    };
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let wrote = serde_json::to_writer(&mut stdout, &response).is_ok() && stdout.flush().is_ok();
    Some(if wrote { 0 } else { 2 })
}

#[cfg(not(target_os = "macos"))]
fn extract_pdf_text(_bytes: &[u8]) -> Result<String, String> {
    Err("PDF attachments are supported by the macOS desktop app".to_string())
}

#[tauri::command]
pub fn agent_config_get(app: AppHandle) -> Result<AgentConfig, String> {
    let meta = read_meta(&app)?;
    let credential_source = agent::key::source(&app, &meta);
    Ok(agent::public_config(meta, credential_source))
}

#[tauri::command]
pub fn agent_config_set(app: AppHandle, input: AgentConfigInput) -> Result<AgentConfig, String> {
    let existing = read_meta(&app)?;
    let api_key = input
        .api_key
        .clone()
        .and_then(|value| agent::normalize_api_key(&value));
    let mut meta = agent::normalize_meta(input, &existing)?;

    if let Some(api_key) = api_key {
        agent::key::store(&app, &api_key)?;
        meta.api_key = None;
        meta.api_key_configured = true;
    }

    write_meta(&app, &meta)?;
    let credential_source = agent::key::source(&app, &meta);
    Ok(agent::public_config(meta, credential_source))
}

#[tauri::command]
pub fn agent_config_clear(app: AppHandle) -> Result<AgentConfig, String> {
    agent::key::forget(&app)?;
    let meta = HermesConfigMeta::default();
    write_meta(&app, &meta)?;
    let credential_source = agent::key::source(&app, &meta);
    Ok(agent::public_config(meta, credential_source))
}

#[tauri::command]
pub async fn agent_connection_test(app: AppHandle) -> Result<AgentConnectionTestResult, String> {
    let meta = read_meta(&app)?;
    let api_key = agent::key::resolve(&app, &meta).map_err(|e| e.to_string())?;
    agent::test_connection(&meta, &api_key).await
}

#[tauri::command]
pub fn agent_chat_stream(app: AppHandle, input: AgentChatStreamInput) -> Result<(), String> {
    let meta = read_meta(&app)?;
    let api_key = agent::key::resolve(&app, &meta).map_err(|e| e.to_string())?;
    let stream_id = input.stream_id.clone();
    let stream_id_for_event = stream_id.clone();
    let chat_input = AgentChatInput {
        conversation_id: input.conversation_id,
        messages: input.messages,
    };
    tauri::async_runtime::spawn(async move {
        let result = agent::chat_completion_stream(
            &meta,
            &api_key,
            chat_input,
            || Ok(()),
            |event| {
                app.emit(
                    "agent:chat-stream",
                    AgentChatStreamEvent {
                        stream_id: stream_id_for_event.clone(),
                        event,
                    },
                )
                .map_err(|e| e.to_string())
            },
        )
        .await;
        match result {
            Ok(()) => {
                let _ = app.emit(
                    "agent:chat-stream",
                    AgentChatStreamEvent {
                        stream_id,
                        event: agent::AgentStreamEvent {
                            kind: "done".to_string(),
                            delta: None,
                            error: None,
                            tool_call_id: None,
                            tool_name: None,
                            input_text_delta: None,
                            input: None,
                            output: None,
                            error_text: None,
                            title: None,
                            dynamic: None,
                        },
                    },
                );
            }
            Err(error) => {
                let _ = app.emit(
                    "agent:chat-stream",
                    AgentChatStreamEvent {
                        stream_id,
                        event: agent::AgentStreamEvent::error(error),
                    },
                );
            }
        }
    });
    Ok(())
}

/// Create a persisted run and return before its Hermes request completes.
/// The process-owned task below, rather than the invoking webview, owns the
/// request. The UI can therefore reconnect by run id after navigation/reload.
#[tauri::command]
pub fn agent_run_create(
    app: AppHandle,
    state: State<AppState>,
    input: AgentRunCreateInput,
) -> Result<AgentRunDto, String> {
    let app_data = app_data_dir(&app)?;
    let now = chrono::Local::now().to_rfc3339();
    let _mutation = state.agent_run_mutations.lock_recover();
    let (mut run, created) = runs::create_or_get(&app_data, input.into(), &now)?;
    if !created {
        return Ok(AgentRunDto::from(&run));
    }

    if let Err(error) = ensure_run_user_message(&app, &state, &run) {
        run = runs::fail(
            &app_data,
            &run.id,
            &error,
            &chrono::Local::now().to_rfc3339(),
        )?;
        return Ok(AgentRunDto::from(&run));
    }

    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    state
        .agent_run_cancellations
        .lock_recover()
        .insert(run.id.clone(), cancel_tx);
    let run_id = run.id.clone();
    drop(_mutation);
    tauri::async_runtime::spawn(run_agent_job(app, run_id, cancel_rx));
    Ok(AgentRunDto::from(&run))
}

#[tauri::command]
pub fn agent_run_get(
    app: AppHandle,
    state: State<AppState>,
    run_id: String,
) -> Result<Option<AgentRunDto>, String> {
    let app_data = app_data_dir(&app)?;
    let _mutation = state.agent_run_mutations.lock_recover();
    let Some(run) = runs::read(&app_data, &run_id)? else {
        return Ok(None);
    };
    let run = reconcile_run(&app, &state, &app_data, run)?;
    Ok(Some(AgentRunDto::from(&run)))
}

#[tauri::command]
pub fn agent_runs_for_conversation(
    app: AppHandle,
    state: State<AppState>,
    conversation_id: String,
) -> Result<Vec<AgentRunDto>, String> {
    crate::vault::validate_record_id(conversation_id.trim())?;
    let app_data = app_data_dir(&app)?;
    let _mutation = state.agent_run_mutations.lock_recover();
    let mut output = Vec::new();
    for run in runs::list_for_conversation(&app_data, &conversation_id, 20)? {
        let run = reconcile_run(&app, &state, &app_data, run)?;
        output.push(AgentRunDto::from(&run));
    }
    Ok(output)
}

#[tauri::command]
pub fn agent_run_cancel(
    app: AppHandle,
    state: State<AppState>,
    run_id: String,
) -> Result<AgentRunDto, String> {
    let app_data = app_data_dir(&app)?;
    let _mutation = state.agent_run_mutations.lock_recover();
    let cancellations = state.agent_run_cancellations.lock_recover();
    let run = cancel_persisted_run(
        &app_data,
        &run_id,
        &chrono::Local::now().to_rfc3339(),
        cancellations.get(&run_id),
    )?;
    Ok(AgentRunDto::from(&run))
}

#[tauri::command]
pub fn agent_chats_all(app: AppHandle) -> Result<Vec<AgentChatSummary>, String> {
    let vault = vault_root(&app)?;
    agent::read_all_chat_summaries(&vault)
}

#[tauri::command]
pub fn agent_chat_get(app: AppHandle, id: String) -> Result<Option<AgentChatRecord>, String> {
    let vault = vault_root(&app)?;
    agent::read_chat_by_id(&vault, &id)
}

#[tauri::command]
pub fn agent_chat_create(
    app: AppHandle,
    state: State<AppState>,
    input: AgentChatCreateInput,
) -> Result<AgentChatRecord, String> {
    let _agent_mutation = state.agent_run_mutations.lock_recover();
    let vault = vault_root(&app)?;
    let meta = read_meta(&app)?;
    let mut chat = agent::new_chat_record(&meta, input.title);
    chat.context = input.context;
    let path = agent::chat_path(&vault, &chat.id)?;
    write_chat(&app, &state, &vault, &path, &chat)?;
    Ok(chat)
}

#[tauri::command]
pub fn agent_chat_update(
    app: AppHandle,
    state: State<AppState>,
    input: AgentChatUpdateInput,
) -> Result<AgentChatRecord, String> {
    let _agent_mutation = state.agent_run_mutations.lock_recover();
    let vault = vault_root(&app)?;
    let meta = read_meta(&app)?;
    let path = agent::chat_path(&vault, &input.id)?;
    let mut chat = if path.exists() {
        agent::read_chat(&vault, &path)?
    } else {
        let mut next = agent::new_chat_record(&meta, input.title.clone());
        next.id = input.id.clone();
        next.path = format!("{}/{}.md", crate::vault::AGENT_DIR, next.id);
        next
    };

    chat.agent = input
        .agent
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(meta.display_name.as_str())
        .to_string();
    chat.model = input
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(meta.model.as_str())
        .to_string();
    chat.messages = input.messages;
    if let Some(pinned) = input.pinned {
        chat.pinned = pinned;
    }
    chat.updated = chrono::Local::now().to_rfc3339();
    chat.title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "New chat")
        .map(str::to_string)
        .or_else(|| agent::title_from_messages(&chat.messages))
        .unwrap_or_else(|| "New chat".to_string());
    if chat.tags.is_empty() {
        chat.tags.push("agent".to_string());
    }

    write_chat(&app, &state, &vault, &path, &chat)?;
    agent::read_chat(&vault, &path)
}

#[tauri::command]
pub fn agent_chat_delete(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let _agent_mutation = state.agent_run_mutations.lock_recover();
    if let Ok(app_data) = app_data_dir(&app) {
        for run in runs::list_for_conversation(&app_data, &id, usize::MAX)? {
            if !runs::is_active(run.status) {
                continue;
            }
            let cancellations = state.agent_run_cancellations.lock_recover();
            cancel_persisted_run(
                &app_data,
                &run.id,
                &chrono::Local::now().to_rfc3339(),
                cancellations.get(&run.id),
            )?;
        }
    }
    let vault = vault_root(&app)?;
    let path = agent::chat_path(&vault, &id)?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(&path);
    }
    if path.exists() {
        vault_lib::move_to_trash(&vault, &path)?;
    }
    if let Ok(idx) = state.ensure_index(&app) {
        let rel = crate::index::rel_path_str(&vault, &path);
        if let Err(e) = idx.delete_by_path(&rel) {
            eprintln!("unindex agent chat {}: {}", id, e);
        }
    }
    Ok(())
}

fn read_meta(app: &AppHandle) -> Result<HermesConfigMeta, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut meta = match store.get(agent::STORE_KEY) {
        Some(value) => serde_json::from_value(value).map_err(|e| e.to_string()),
        None => Ok(HermesConfigMeta::default()),
    }?;
    if let Some(legacy_key) = meta.api_key.as_deref().and_then(agent::normalize_api_key) {
        agent::key::store(app, &legacy_key)?;
        meta.api_key = None;
        meta.api_key_configured = true;
        write_meta(app, &meta)?;
    }
    Ok(meta)
}

fn write_meta(app: &AppHandle, meta: &HermesConfigMeta) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(
        agent::STORE_KEY,
        serde_json::to_value(meta).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("resolve app data directory: {error}"))
}

async fn run_agent_job(
    app: AppHandle,
    run_id: String,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    let result = run_agent_job_inner(&app, &run_id, &mut cancel_rx).await;
    if let Err(error) = result {
        if let Ok(app_data) = app_data_dir(&app) {
            let state = app.state::<AppState>();
            let _mutation = state.agent_run_mutations.lock_recover();
            let _ = runs::fail(
                &app_data,
                &run_id,
                &error,
                &chrono::Local::now().to_rfc3339(),
            );
        }
    }
    app.state::<AppState>()
        .agent_run_cancellations
        .lock_recover()
        .remove(&run_id);
}

async fn run_agent_job_inner(
    app: &AppHandle,
    run_id: &str,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    let app_data = app_data_dir(app)?;
    let state = app.state::<AppState>();
    let run = {
        let _mutation = state.agent_run_mutations.lock_recover();
        runs::mark_running(&app_data, run_id, &chrono::Local::now().to_rfc3339())?
    };
    if run.status == runs::AgentRunStatus::Cancelled {
        return Ok(());
    }

    let meta = read_meta(app)?;
    let api_key = agent::key::resolve(app, &meta).map_err(|error| error.to_string())?;
    let chat_input = AgentChatInput {
        conversation_id: run.session_id.clone(),
        messages: run.request_messages.clone(),
    };
    let progress = Arc::new(Mutex::new(AgentRunProgress {
        response: String::new(),
        pending_events: Vec::new(),
    }));
    let progress_for_events = progress.clone();
    let stream = agent::chat_completion_stream(
        &meta,
        &api_key,
        chat_input,
        || Ok(()),
        |event| {
            let mut progress = progress_for_events.lock_recover();
            if event.kind == "delta" {
                if let Some(delta) = event.delta.as_deref() {
                    progress.response.push_str(delta);
                }
            }
            push_coalesced_agent_event(&mut progress.pending_events, event);
            Ok(())
        },
    );
    let stream_result = wait_for_agent_stream(
        stream,
        wait_for_cancel(cancel_rx),
        AGENT_RUN_EVENT_FLUSH_INTERVAL,
        || flush_agent_run_events(&app_data, &state, run_id, &progress),
    )
    .await;
    let final_response = progress.lock_recover().response.clone();
    flush_agent_run_events(&app_data, &state, run_id, &progress)?;
    let _mutation = state.agent_run_mutations.lock_recover();
    match stream_result {
        None => {
            runs::cancel(&app_data, run_id, &chrono::Local::now().to_rfc3339())?;
        }
        Some(Err(error)) => return Err(error),
        Some(Ok(())) => {
            finalize_successful_run(
                &app_data,
                run_id,
                &final_response,
                &chrono::Local::now().to_rfc3339(),
                |completed| reconcile_completed_chat(app, &state, completed),
            )?;
        }
    }
    Ok(())
}

fn flush_agent_run_events(
    app_data: &Path,
    state: &AppState,
    run_id: &str,
    progress: &Arc<Mutex<AgentRunProgress>>,
) -> Result<(), String> {
    let pending_events = {
        let mut progress = progress.lock_recover();
        std::mem::take(&mut progress.pending_events)
    };
    if pending_events.is_empty() {
        return Ok(());
    }
    let _mutation = state.agent_run_mutations.lock_recover();
    runs::append_events(
        app_data,
        run_id,
        pending_events,
        &chrono::Local::now().to_rfc3339(),
    )?;
    Ok(())
}

async fn wait_for_agent_stream<Stream, Cancel, Flush>(
    stream: Stream,
    cancel: Cancel,
    flush_interval: Duration,
    mut flush: Flush,
) -> Option<Result<(), String>>
where
    Stream: Future<Output = Result<(), String>>,
    Cancel: Future<Output = ()>,
    Flush: FnMut() -> Result<(), String>,
{
    tokio::pin!(stream);
    tokio::pin!(cancel);
    let mut interval = tokio::time::interval(flush_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await;
    loop {
        tokio::select! {
            result = &mut stream => return Some(result),
            _ = &mut cancel => return None,
            _ = interval.tick() => {
                if let Err(error) = flush() {
                    return Some(Err(error));
                }
            }
        }
    }
}

async fn wait_for_cancel(receiver: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *receiver.borrow() {
            return;
        }
        if receiver.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

fn cancel_persisted_run(
    app_data: &Path,
    run_id: &str,
    now: &str,
    sender: Option<&tokio::sync::watch::Sender<bool>>,
) -> Result<AgentRunRecord, String> {
    let run = runs::cancel(app_data, run_id, now)?;
    if let Some(sender) = sender {
        let _ = sender.send(true);
    }
    Ok(run)
}

fn finalize_successful_run(
    app_data: &Path,
    run_id: &str,
    response: &str,
    now: &str,
    finalize_transcript: impl FnOnce(&AgentRunRecord) -> Result<(), String>,
) -> Result<AgentRunRecord, String> {
    let completed = runs::complete(app_data, run_id, response, now)?;
    if completed.status != runs::AgentRunStatus::Completed
        || completed.transcript_finalized_at.is_some()
    {
        return Ok(completed);
    }
    finalize_transcript(&completed)?;
    runs::mark_transcript_finalized(app_data, run_id, now)
}

fn reconcile_run(
    app: &AppHandle,
    state: &State<AppState>,
    app_data: &Path,
    run: AgentRunRecord,
) -> Result<AgentRunRecord, String> {
    let run = if runs::is_active(run.status) {
        let is_live = state
            .agent_run_cancellations
            .lock_recover()
            .contains_key(&run.id);
        runs::recover_stale(
            app_data,
            &run.id,
            is_live,
            &chrono::Local::now().to_rfc3339(),
        )?
    } else {
        run
    };
    if run.status == runs::AgentRunStatus::Completed && run.transcript_finalized_at.is_none() {
        reconcile_completed_chat(app, state, &run)?;
        return runs::mark_transcript_finalized(
            app_data,
            &run.id,
            &chrono::Local::now().to_rfc3339(),
        );
    }
    Ok(run)
}

fn ensure_run_user_message(
    app: &AppHandle,
    state: &State<AppState>,
    run: &AgentRunRecord,
) -> Result<(), String> {
    let mut chat = load_or_create_run_chat(app, run)?;
    if runs::ensure_user_message_once(&mut chat, run) {
        update_chat_metadata(&mut chat, run.input_message.created_at.as_str());
        let vault = vault_root(app)?;
        let path = agent::chat_path(&vault, &chat.id)?;
        write_chat(app, state, &vault, &path, &chat)?;
    }
    Ok(())
}

fn reconcile_completed_chat(
    app: &AppHandle,
    state: &State<AppState>,
    run: &AgentRunRecord,
) -> Result<(), String> {
    let mut chat = load_or_create_run_chat(app, run)?;
    let user_changed = runs::ensure_user_message_once(&mut chat, run);
    let assistant_changed = runs::finalize_chat_once(&mut chat, run);
    if user_changed || assistant_changed {
        update_chat_metadata(&mut chat, run.updated_at.as_str());
        let vault = vault_root(app)?;
        let path = agent::chat_path(&vault, &chat.id)?;
        write_chat(app, state, &vault, &path, &chat)?;
    }
    Ok(())
}

fn load_or_create_run_chat(
    app: &AppHandle,
    run: &AgentRunRecord,
) -> Result<AgentChatRecord, String> {
    let vault = vault_root(app)?;
    if let Some(chat) = agent::read_chat_by_id(&vault, &run.conversation_id)? {
        return Ok(chat);
    }
    let meta = read_meta(app)?;
    let mut chat = agent::new_chat_record(&meta, None);
    chat.id = run.conversation_id.clone();
    chat.path = format!("{}/{}.md", crate::vault::AGENT_DIR, chat.id);
    Ok(chat)
}

fn update_chat_metadata(chat: &mut AgentChatRecord, updated_at: &str) {
    chat.updated = updated_at.to_string();
    chat.title =
        agent::title_from_messages(&chat.messages).unwrap_or_else(|| "New chat".to_string());
    if chat.tags.is_empty() {
        chat.tags.push("agent".to_string());
    }
}

fn write_chat(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    abs_path: &Path,
    chat: &AgentChatRecord,
) -> Result<(), String> {
    let serialized = agent::serialize_chat(chat).map_err(|e| format!("{:#}", e))?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &serialized).map_err(|e| e.to_string())?;
    if let Ok(idx) = state.ensure_index(app) {
        let rel = crate::index::rel_path_str(vault, abs_path);
        if let Err(e) = idx.upsert(&crate::index::doc_from_agent_chat(chat, &rel)) {
            eprintln!("index agent chat {}: {}", chat.id, e);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }

    fn new_run() -> runs::NewAgentRun {
        runs::NewAgentRun {
            conversation_id: "agent-conversation-test".to_string(),
            idempotency_key: "user-message-test".to_string(),
            input_message: agent::AgentVaultMessage {
                id: "user-message-test".to_string(),
                role: "user".to_string(),
                created_at: "2031-02-03T12:00:00Z".to_string(),
                content: "Summarize the attached notes.".to_string(),
            },
            request_messages: vec![agent::AgentChatMessage {
                role: "user".to_string(),
                content: "Summarize the attached notes.".to_string(),
            }],
            retry_of: None,
        }
    }

    fn empty_chat() -> AgentChatRecord {
        AgentChatRecord {
            id: "agent-conversation-test".to_string(),
            path: "agent/agent-conversation-test.md".to_string(),
            title: "Notes summary".to_string(),
            agent: "Local agent".to_string(),
            model: "test-model".to_string(),
            created: "2031-02-03T11:00:00Z".to_string(),
            updated: "2031-02-03T11:00:00Z".to_string(),
            pinned: false,
            tags: vec!["agent".to_string()],
            context: None,
            messages: Vec::new(),
        }
    }

    #[test]
    fn command_cancellation_path_persists_status_and_signals_the_runner() {
        let temp = tempfile::tempdir().unwrap();
        let (run, _) = runs::create_or_get(temp.path(), new_run(), "2031-02-03T12:00:00Z").unwrap();
        runs::mark_running(temp.path(), &run.id, "2031-02-03T12:00:01Z").unwrap();
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

        let cancelled = cancel_persisted_run(
            temp.path(),
            &run.id,
            "2031-02-03T12:00:02Z",
            Some(&cancel_tx),
        )
        .unwrap();

        assert_eq!(cancelled.status, runs::AgentRunStatus::Cancelled);
        assert!(*cancel_rx.borrow());
        let late_completion = runs::complete(
            temp.path(),
            &run.id,
            "This response must not be saved.",
            "2031-02-03T12:00:03Z",
        )
        .unwrap();
        assert_eq!(late_completion.status, runs::AgentRunStatus::Cancelled);
        assert!(late_completion.final_response.is_none());
    }

    #[test]
    fn adjacent_agent_deltas_are_compacted_before_persistence() {
        let mut events = Vec::new();
        for index in 0..250 {
            push_coalesced_agent_event(
                &mut events,
                agent::AgentStreamEvent::text_delta(format!("token-{index} ")),
            );
        }
        push_coalesced_agent_event(
            &mut events,
            agent::AgentStreamEvent::reasoning_delta("checking ".to_string()),
        );
        push_coalesced_agent_event(
            &mut events,
            agent::AgentStreamEvent::reasoning_delta("sources".to_string()),
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "delta");
        assert_eq!(
            events[0]
                .delta
                .as_deref()
                .unwrap()
                .matches("token-")
                .count(),
            250
        );
        assert_eq!(events[1].kind, "reasoning-delta");
        assert_eq!(events[1].delta.as_deref(), Some("checking sources"));
    }

    #[tokio::test]
    async fn agent_stream_flush_timer_runs_without_another_event() {
        let mut flushes = 0;
        let result = tokio::time::timeout(
            Duration::from_millis(200),
            wait_for_agent_stream(
                async {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    Ok(())
                },
                std::future::pending(),
                Duration::from_millis(10),
                || {
                    flushes += 1;
                    Err("stop after scheduled flush".to_string())
                },
            ),
        )
        .await
        .expect("scheduled flush should run without another stream event");

        assert_eq!(result, Some(Err("stop after scheduled flush".to_string())));
        assert_eq!(flushes, 1);
    }

    #[test]
    fn prepares_pdf_text_without_exposing_a_filesystem_path_to_the_agent() {
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(synthetic_pdf("Synthetic review text"));

        let prepared = prepare_agent_attachment_in_process(AgentAttachmentPrepareInput {
            filename: Some("review.pdf".to_string()),
            media_type: Some("application/pdf".to_string()),
            data_url: format!("data:application/pdf;base64,{encoded}"),
        })
        .unwrap();

        assert!(prepared.context.contains("Synthetic review text"));
        assert!(prepared.context.contains("review.pdf (application/pdf)"));
        assert!(!prepared.context.contains("file://"));
        assert!(!prepared.context.contains("/Users/"));
    }

    #[test]
    fn rejects_a_pdf_that_has_no_extractable_text() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"%PDF-invalid");

        let error = prepare_agent_attachment_in_process(AgentAttachmentPrepareInput {
            filename: Some("scan.pdf".to_string()),
            media_type: Some("application/pdf".to_string()),
            data_url: format!("data:application/pdf;base64,{encoded}"),
        })
        .unwrap_err();

        assert!(error.contains("extract"));
    }

    #[test]
    fn prepares_text_and_sanitizes_its_display_label() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"Synthetic notes");

        let prepared = prepare_agent_attachment_in_process(AgentAttachmentPrepareInput {
            filename: Some("folder/\nnotes.txt".to_string()),
            media_type: Some("text/plain".to_string()),
            data_url: format!("data:text/plain;base64,{encoded}"),
        })
        .unwrap();

        assert!(prepared
            .context
            .contains("[Attachment: notes.txt (text/plain)]"));
        assert!(prepared.context.contains("Synthetic notes"));
    }

    #[test]
    fn rejects_unsupported_invalid_and_oversized_attachment_inputs() {
        let unsupported = prepare_agent_attachment_in_process(AgentAttachmentPrepareInput {
            filename: Some("image.png".to_string()),
            media_type: Some("image/png".to_string()),
            data_url: "data:image/png;base64,AA==".to_string(),
        })
        .unwrap_err();
        assert!(unsupported.contains("PDF and text"));

        let invalid = prepare_agent_attachment_in_process(AgentAttachmentPrepareInput {
            filename: Some("notes.txt".to_string()),
            media_type: Some("text/plain".to_string()),
            data_url: "data:text/plain;base64,not-base64".to_string(),
        })
        .unwrap_err();
        assert!(invalid.contains("valid base64"));

        let max_encoded = MAX_AGENT_ATTACHMENT_BYTES.div_ceil(3) * 4;
        let oversized = prepare_agent_attachment_in_process(AgentAttachmentPrepareInput {
            filename: Some("notes.txt".to_string()),
            media_type: Some("text/plain".to_string()),
            data_url: format!("data:text/plain;base64,{}", "A".repeat(max_encoded + 1)),
        })
        .unwrap_err();
        assert!(oversized.contains("byte limit"));
    }

    #[test]
    fn pdf_page_text_is_bounded_without_a_duplicate_character_scan() {
        let mut output = "abc".to_string();
        append_pdf_page_text(&mut output, "def", 7).unwrap();
        assert_eq!(output, "abc\ndef");

        let error = append_pdf_page_text(&mut output, "g", 7).unwrap_err();
        assert!(error.contains("byte limit"));
        assert_eq!(output, "abc\ndef");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn helper_receives_eof_after_attachment_input_is_written() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "cat >/dev/null; printf finished"]);

        let output = run_bounded_helper(
            command,
            b"synthetic attachment bytes".to_vec(),
            Duration::from_millis(100),
            64,
        )
        .await
        .unwrap();

        assert_eq!(output, b"finished");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn attachment_timeout_kills_and_reaps_the_helper_process() {
        let mut command = tokio::process::Command::new("/bin/sleep");
        command.arg("5");
        let started = std::time::Instant::now();

        let error = run_bounded_helper(command, Vec::new(), Duration::from_millis(10), 64)
            .await
            .unwrap_err();

        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn runner_completion_path_finalizes_the_persisted_transcript_once() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let vault = temp.path().join("vault");
        vault_lib::ensure_dirs(&vault).unwrap();
        let (run, _) = runs::create_or_get(&app_data, new_run(), "2031-02-03T12:00:00Z").unwrap();
        runs::mark_running(&app_data, &run.id, "2031-02-03T12:00:01Z").unwrap();
        let chat_path = agent::chat_path(&vault, &run.conversation_id).unwrap();
        vault_lib::write_atomic(&chat_path, &agent::serialize_chat(&empty_chat()).unwrap())
            .unwrap();

        let finalize = |completed: &AgentRunRecord| -> Result<(), String> {
            let mut chat = agent::read_chat(&vault, &chat_path)?;
            runs::ensure_user_message_once(&mut chat, completed);
            runs::finalize_chat_once(&mut chat, completed);
            let serialized = agent::serialize_chat(&chat).map_err(|error| error.to_string())?;
            vault_lib::write_atomic(&chat_path, &serialized).map_err(|error| error.to_string())
        };
        let finalized = finalize_successful_run(
            &app_data,
            &run.id,
            "The notes describe three decisions.",
            "2031-02-03T12:00:02Z",
            finalize,
        )
        .unwrap();
        assert!(finalized.transcript_finalized_at.is_some());

        finalize_successful_run(
            &app_data,
            &run.id,
            "The notes describe three decisions.",
            "2031-02-03T12:00:03Z",
            |_| panic!("an already finalized run must not rewrite its transcript"),
        )
        .unwrap();

        let chat = agent::read_chat(&vault, &chat_path).unwrap();
        let assistant_messages = chat
            .messages
            .iter()
            .filter(|message| message.id == run.assistant_message_id)
            .collect::<Vec<_>>();
        assert_eq!(assistant_messages.len(), 1);
        assert_eq!(
            assistant_messages[0].content,
            "The notes describe three decisions."
        );
        assert_eq!(
            chat.messages
                .iter()
                .filter(|message| message.id == run.input_message.id)
                .count(),
            1
        );
    }
}
