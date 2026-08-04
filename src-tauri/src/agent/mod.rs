pub mod key;
pub mod runs;

use anyhow::{anyhow, Context};
use gray_matter::{engine::YAML, Matter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use ulid::Ulid;

pub const STORE_KEY: &str = "agent_hermes_config";
// The desktop app talks to a Hermes gateway running on the same machine. (A
// future mobile app will point at a VPS-hosted gateway instead.)
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8644/v1";
pub const DEFAULT_MODEL: &str = "cadence";
pub const DEFAULT_SESSION_KEY: &str = "woodshed";
pub const DEFAULT_DISPLAY_NAME: &str = "Hermes";
pub const CHAT_TYPE: &str = "agent_chat";
const MESSAGE_START: &str = "<!-- woodshed-agent-message";
const MESSAGE_END: &str = "<!-- /woodshed-agent-message -->";
const MAX_AGENT_URL_BYTES: usize = 2 * 1024;
const MAX_AGENT_MODELS_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_AGENT_CHAT_RESPONSE: usize = 16 * 1024 * 1024;
const MAX_AGENT_STREAM_BYTES: usize = 32 * 1024 * 1024;
const MAX_AGENT_STREAM_BUFFER: usize = 1024 * 1024;
const MAX_AGENT_MESSAGES: usize = 512;
const MAX_AGENT_INPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesConfigMeta {
    #[serde(default = "default_display_name")]
    pub display_name: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_session_key")]
    pub session_key: String,
    /// Legacy plaintext value: accepted for one-time migration only.
    #[serde(default, skip_serializing)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub api_key_configured: bool,
}

impl Default for HermesConfigMeta {
    fn default() -> Self {
        Self {
            display_name: default_display_name(),
            base_url: default_base_url(),
            model: default_model(),
            session_key: default_session_key(),
            api_key: None,
            api_key_configured: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub display_name: String,
    pub base_url: String,
    pub model: String,
    pub session_key: String,
    pub has_api_key: bool,
    pub credential_source: CredentialSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialSource {
    Environment,
    Hermes,
    Stored,
    Missing,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigInput {
    #[serde(default)]
    pub display_name: Option<String>,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub session_key: Option<String>,
    /// Optional replacement secret. None means "leave the existing key alone."
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionTestResult {
    pub ok: bool,
    pub status: u16,
    pub model_found: bool,
    pub models: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatInput {
    pub conversation_id: String,
    pub messages: Vec<AgentChatMessage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatStreamInput {
    pub stream_id: String,
    pub conversation_id: String,
    pub messages: Vec<AgentChatMessage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatStreamEvent {
    pub stream_id: String,
    #[serde(flatten)]
    pub event: AgentStreamEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_text_delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamic: Option<bool>,
}

impl AgentStreamEvent {
    pub fn text_delta(delta: String) -> Self {
        Self {
            kind: "delta".to_string(),
            delta: Some(delta),
            error: None,
            tool_call_id: None,
            tool_name: None,
            input_text_delta: None,
            input: None,
            output: None,
            error_text: None,
            title: None,
            dynamic: None,
        }
    }

    pub fn reasoning_delta(delta: String) -> Self {
        Self {
            kind: "reasoning-delta".to_string(),
            delta: Some(delta),
            error: None,
            tool_call_id: None,
            tool_name: None,
            input_text_delta: None,
            input: None,
            output: None,
            error_text: None,
            title: None,
            dynamic: None,
        }
    }

    pub fn tool_input_start(
        tool_call_id: String,
        tool_name: String,
        title: Option<String>,
    ) -> Self {
        Self {
            kind: "tool-input-start".to_string(),
            delta: None,
            error: None,
            tool_call_id: Some(tool_call_id),
            tool_name: Some(tool_name),
            input_text_delta: None,
            input: None,
            output: None,
            error_text: None,
            title,
            dynamic: Some(true),
        }
    }

    pub fn tool_input_delta(tool_call_id: String, input_text_delta: String) -> Self {
        Self {
            kind: "tool-input-delta".to_string(),
            delta: None,
            error: None,
            tool_call_id: Some(tool_call_id),
            tool_name: None,
            input_text_delta: Some(input_text_delta),
            input: None,
            output: None,
            error_text: None,
            title: None,
            dynamic: None,
        }
    }

    pub fn tool_input_available(
        tool_call_id: String,
        tool_name: String,
        input: Value,
        title: Option<String>,
    ) -> Self {
        Self {
            kind: "tool-input-available".to_string(),
            delta: None,
            error: None,
            tool_call_id: Some(tool_call_id),
            tool_name: Some(tool_name),
            input_text_delta: None,
            input: Some(input),
            output: None,
            error_text: None,
            title,
            dynamic: Some(true),
        }
    }

    pub fn error(error: String) -> Self {
        Self {
            kind: "error".to_string(),
            delta: None,
            error: Some(error),
            tool_call_id: None,
            tool_name: None,
            input_text_delta: None,
            input: None,
            output: None,
            error_text: None,
            title: None,
            dynamic: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatResponse {
    pub id: Option<String>,
    pub model: String,
    pub content: String,
    pub usage: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentVaultMessage {
    pub id: String,
    pub role: String,
    pub created_at: String,
    pub content: String,
}

/// Lightweight descriptor of the page a chat was started from (sidebar mode).
/// Persisted so the full Agent view can show which page is attached as context.
/// Just the label + route — the live page snapshot is re-captured at send time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatContext {
    pub title: String,
    pub route: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatRecord {
    pub id: String,
    pub path: String,
    pub title: String,
    pub agent: String,
    pub model: String,
    pub created: String,
    pub updated: String,
    pub pinned: bool,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<AgentChatContext>,
    pub messages: Vec<AgentVaultMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatSummary {
    pub id: String,
    pub path: String,
    pub title: String,
    pub agent: String,
    pub model: String,
    pub created: String,
    pub updated: String,
    pub last_message_created: Option<String>,
    pub pinned: bool,
    pub message_count: usize,
    pub preview: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<AgentChatContext>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatCreateInput {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub context: Option<AgentChatContext>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatUpdateInput {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub messages: Vec<AgentVaultMessage>,
}

#[derive(Debug, Clone, Deserialize)]
struct AgentChatFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    title: String,
    agent: String,
    model: String,
    created: String,
    updated: String,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    context: Option<AgentChatContext>,
}

#[derive(Debug, Clone, Serialize)]
struct AgentChatFrontmatterOut<'a> {
    #[serde(rename = "type")]
    type_: &'static str,
    id: &'a str,
    title: &'a str,
    agent: &'a str,
    model: &'a str,
    created: &'a str,
    updated: &'a str,
    #[serde(skip_serializing_if = "is_false")]
    pinned: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<&'a AgentChatContext>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct AgentMessageMeta {
    id: String,
    role: String,
    created: String,
}

pub fn normalize_meta(
    input: AgentConfigInput,
    existing: &HermesConfigMeta,
) -> Result<HermesConfigMeta, String> {
    let display_name = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            let existing = existing.display_name.trim();
            if existing.is_empty() {
                DEFAULT_DISPLAY_NAME
            } else {
                existing
            }
        })
        .to_string();
    let base_url = normalize_base_url(&input.base_url)?;
    let model = input.model.trim().to_string();
    if model.is_empty() {
        return Err("model is required".to_string());
    }
    let session_key = input
        .session_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_SESSION_KEY)
        .to_string();
    Ok(HermesConfigMeta {
        display_name,
        base_url,
        model,
        session_key,
        api_key_configured: existing.api_key_configured
            || existing
                .api_key
                .as_deref()
                .and_then(normalize_api_key)
                .is_some(),
        api_key: None,
    })
}

pub fn public_config(meta: HermesConfigMeta, credential_source: CredentialSource) -> AgentConfig {
    AgentConfig {
        display_name: if meta.display_name.trim().is_empty() {
            default_display_name()
        } else {
            meta.display_name
        },
        base_url: meta.base_url,
        model: meta.model,
        session_key: meta.session_key,
        has_api_key: meta.api_key_configured
            || meta
                .api_key
                .as_deref()
                .and_then(normalize_api_key)
                .is_some()
            || credential_source != CredentialSource::Missing,
        credential_source,
    }
}

pub fn chats_dir(vault: &Path) -> PathBuf {
    crate::vault::agent_dir(vault)
}

pub fn chat_path(vault: &Path, id: &str) -> std::result::Result<PathBuf, String> {
    crate::vault::record_file_path(vault, crate::vault::AGENT_DIR, id)
}

pub fn new_chat_record(config: &HermesConfigMeta, title: Option<String>) -> AgentChatRecord {
    let id = format!("agent-{}", Ulid::new().to_string().to_ascii_lowercase());
    let now = chrono::Local::now().to_rfc3339();
    AgentChatRecord {
        path: format!("{}/{}.md", crate::vault::AGENT_DIR, id),
        id,
        title: title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("New chat")
            .to_string(),
        agent: display_name_or_default(&config.display_name),
        model: config.model.clone(),
        created: now.clone(),
        updated: now,
        pinned: false,
        tags: vec!["agent".to_string()],
        context: None,
        messages: Vec::new(),
    }
}

pub fn parse_chat(content: &str, vault_rel_path: &str) -> anyhow::Result<AgentChatRecord> {
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed
        .data
        .ok_or_else(|| anyhow!("agent chat file has no frontmatter"))?;
    let fm: AgentChatFrontmatter = data
        .deserialize()
        .context("deserialize agent chat frontmatter")?;
    if fm.type_ != CHAT_TYPE {
        return Err(anyhow!("expected type=agent_chat, got type={}", fm.type_));
    }
    Ok(AgentChatRecord {
        id: fm.id,
        path: vault_rel_path.to_string(),
        title: fm.title,
        agent: display_name_or_default(&fm.agent),
        model: fm.model,
        created: fm.created,
        updated: fm.updated,
        pinned: fm.pinned,
        tags: fm.tags,
        context: fm.context,
        messages: parse_message_blocks(&parsed.content)?,
    })
}

pub fn serialize_chat(chat: &AgentChatRecord) -> anyhow::Result<String> {
    let fm = AgentChatFrontmatterOut {
        type_: CHAT_TYPE,
        id: &chat.id,
        title: &chat.title,
        agent: &chat.agent,
        model: &chat.model,
        created: &chat.created,
        updated: &chat.updated,
        pinned: chat.pinned,
        tags: chat.tags.clone(),
        context: chat.context.as_ref(),
    };
    let yaml = serde_yaml::to_string(&fm).context("serialize agent chat frontmatter")?;
    let body = chat
        .messages
        .iter()
        .map(serialize_message_block)
        .collect::<Vec<_>>()
        .join("\n\n");
    if body.is_empty() {
        Ok(format!("---\n{}---\n", yaml))
    } else {
        Ok(format!("---\n{}---\n\n{}", yaml, body))
    }
}

pub fn read_chat(vault: &Path, abs_path: &Path) -> std::result::Result<AgentChatRecord, String> {
    let content = crate::vault::read_record(abs_path).map_err(|e| e.to_string())?;
    let rel = crate::index::rel_path_str(vault, abs_path);
    parse_chat(&content, &rel).map_err(|e| format!("{:#}", e))
}

pub fn read_chat_by_id(
    vault: &Path,
    id: &str,
) -> std::result::Result<Option<AgentChatRecord>, String> {
    let path = chat_path(vault, id)?;
    if !path.exists() {
        return Ok(None);
    }
    read_chat(vault, &path).map(Some)
}

pub fn read_all_chat_summaries(vault: &Path) -> std::result::Result<Vec<AgentChatSummary>, String> {
    let dir = chats_dir(vault);
    if !crate::vault::is_real_directory(&dir) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !crate::vault::is_real_file(&path)
        {
            continue;
        }
        match read_chat(vault, &path) {
            Ok(chat) => out.push(summary_from_record(&chat)),
            Err(e) => eprintln!("skipping agent chat {}: {}", path.display(), e),
        }
    }
    out.sort_by(|a, b| summary_sort_key(b).cmp(summary_sort_key(a)));
    Ok(out)
}

pub fn summary_from_record(chat: &AgentChatRecord) -> AgentChatSummary {
    let last_message_created = chat
        .messages
        .last()
        .map(|message| message.created_at.clone());
    AgentChatSummary {
        id: chat.id.clone(),
        path: chat.path.clone(),
        title: chat.title.clone(),
        agent: chat.agent.clone(),
        model: chat.model.clone(),
        created: chat.created.clone(),
        updated: chat.updated.clone(),
        last_message_created,
        pinned: chat.pinned,
        message_count: chat.messages.len(),
        preview: chat
            .messages
            .last()
            .map(|message| truncate(&collapse_whitespace(&message.content), 96))
            .unwrap_or_default(),
        context: chat.context.clone(),
    }
}

fn summary_sort_key(summary: &AgentChatSummary) -> &str {
    summary
        .last_message_created
        .as_deref()
        .unwrap_or(summary.updated.as_str())
}

pub fn title_from_messages(messages: &[AgentVaultMessage]) -> Option<String> {
    let first_user = messages
        .iter()
        .find(|message| message.role.eq_ignore_ascii_case("user"))?;
    let text = collapse_whitespace(&first_user.content);
    if text.is_empty() {
        None
    } else {
        Some(truncate(&text, 58))
    }
}

pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("base URL is required".to_string());
    }
    if raw.len() > MAX_AGENT_URL_BYTES || raw.chars().any(char::is_control) {
        return Err("base URL is too long or contains control characters".to_string());
    }
    let parsed = reqwest::Url::parse(raw).map_err(|_| "base URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("base URL must be an HTTP or HTTPS URL with a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("base URL cannot contain credentials".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("base URL cannot contain a query or fragment".to_string());
    }
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

pub fn normalize_api_key(raw: &str) -> Option<String> {
    let mut key = raw.trim();
    if let Some((name, value)) = key.split_once(':') {
        if name.trim().eq_ignore_ascii_case("authorization") {
            key = value.trim();
        }
    }
    if let Some(rest) = key.strip_prefix("Bearer ") {
        key = rest.trim();
    } else if let Some(rest) = key.strip_prefix("bearer ") {
        key = rest.trim();
    }
    (!key.is_empty()).then(|| key.to_string())
}

async fn response_text_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    let bytes = crate::network::read_response_limited(response, max_bytes).await?;
    String::from_utf8(bytes).map_err(|_| "response was not valid UTF-8".to_string())
}

pub async fn test_connection(
    config: &HermesConfigMeta,
    api_key: &str,
) -> Result<AgentConnectionTestResult, String> {
    let base_url = normalize_base_url(&config.base_url)?;
    let models_url = format!("{base_url}/models");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build client failed: {e}"))?;
    let mut request = client
        .get(&models_url)
        .bearer_auth(api_key)
        .header("X-Hermes-Session-Key", config.session_key.trim());
    request = request.header("Accept", "application/json");

    let response = request
        .send()
        .await
        .map_err(|e| format!("connect failed: {e}. Is the local Hermes gateway running?"))?;
    let status = response.status();
    let status_code = status.as_u16();
    let text = response_text_limited(response, MAX_AGENT_MODELS_RESPONSE)
        .await
        .map_err(|e| format!("read response failed: {e}"))?;

    if !status.is_success() {
        return Ok(AgentConnectionTestResult {
            ok: false,
            status: status_code,
            model_found: false,
            models: Vec::new(),
            message: format!(
                "Hermes returned HTTP {status_code}: {}",
                truncate(&text, 240)
            ),
        });
    }

    let parsed: Value =
        serde_json::from_str(&text).map_err(|e| format!("parse /models response failed: {e}"))?;
    let models = parse_model_ids(&parsed);
    let model_found = models.iter().any(|id| id == &config.model);
    let message = if model_found {
        format!("Connected to Hermes and found model '{}'.", config.model)
    } else if models.is_empty() {
        "Connected to Hermes, but /models did not return model ids.".to_string()
    } else {
        format!(
            "Connected to Hermes, but model '{}' was not in /models.",
            config.model
        )
    };

    Ok(AgentConnectionTestResult {
        ok: model_found,
        status: status_code,
        model_found,
        models,
        message,
    })
}

pub async fn chat_completion(
    config: &HermesConfigMeta,
    api_key: &str,
    input: AgentChatInput,
) -> Result<AgentChatResponse, String> {
    let base_url = normalize_base_url(&config.base_url)?;
    let chat_url = format!("{base_url}/chat/completions");
    let session_id = input.conversation_id.trim();
    let session_id = if session_id.is_empty() {
        "default"
    } else {
        session_id
    };
    let messages = normalize_chat_messages(input.messages)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("build client failed: {e}"))?;

    let response = client
        .post(&chat_url)
        .bearer_auth(api_key)
        .header("Accept", "application/json")
        .header("X-Hermes-Session-Key", config.session_key.trim())
        .header("X-Hermes-Session-Id", session_id)
        .json(&json!({
            "model": config.model,
            "messages": messages,
            "stream": false,
        }))
        .send()
        .await
        .map_err(|e| format!("chat failed: {e}. Is the local Hermes gateway running?"))?;

    let status = response.status();
    let status_code = status.as_u16();
    let text = response_text_limited(response, MAX_AGENT_CHAT_RESPONSE)
        .await
        .map_err(|e| format!("read chat response failed: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "Hermes returned HTTP {status_code}: {}",
            truncate(&text, 360)
        ));
    }

    let parsed: Value =
        serde_json::from_str(&text).map_err(|e| format!("parse chat response failed: {e}"))?;
    // Hermes wraps upstream failures in-band (HTTP 200 + an error payload, e.g.
    // a 429 usage-limit). Surface those instead of returning the error string as
    // if it were a normal assistant reply.
    if let Some(err) = upstream_error_message(&parsed) {
        return Err(err);
    }
    let content = parsed
        .pointer("/choices/0/message/content")
        .and_then(message_content_text)
        .ok_or_else(|| "Hermes response did not include assistant text.".to_string())?;
    let id = parsed.get("id").and_then(Value::as_str).map(str::to_string);
    let model = parsed
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(config.model.as_str())
        .to_string();
    let usage = parsed.get("usage").cloned();

    Ok(AgentChatResponse {
        id,
        model,
        content,
        usage,
    })
}

pub async fn chat_completion_stream<Start, Event>(
    config: &HermesConfigMeta,
    api_key: &str,
    input: AgentChatInput,
    mut on_start: Start,
    mut on_event: Event,
) -> Result<(), String>
where
    Start: FnMut() -> Result<(), String>,
    Event: FnMut(AgentStreamEvent) -> Result<(), String>,
{
    chat_completion_stream_with_idle_timeout(
        config,
        api_key,
        input,
        &mut on_start,
        &mut on_event,
        Duration::from_secs(300),
    )
    .await
}

async fn chat_completion_stream_with_idle_timeout<Start, Event>(
    config: &HermesConfigMeta,
    api_key: &str,
    input: AgentChatInput,
    on_start: &mut Start,
    on_event: &mut Event,
    idle_timeout: Duration,
) -> Result<(), String>
where
    Start: FnMut() -> Result<(), String>,
    Event: FnMut(AgentStreamEvent) -> Result<(), String>,
{
    let base_url = normalize_base_url(&config.base_url)?;
    let chat_url = format!("{base_url}/chat/completions");
    let session_id = input.conversation_id.trim();
    let session_id = if session_id.is_empty() {
        "default"
    } else {
        session_id
    };
    let messages = normalize_chat_messages(input.messages)?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build client failed: {e}"))?;

    let mut response = client
        .post(&chat_url)
        .bearer_auth(api_key)
        .header("Accept", "text/event-stream")
        .header("X-Hermes-Session-Key", config.session_key.trim())
        .header("X-Hermes-Session-Id", session_id)
        .json(&json!({
            "model": config.model,
            "messages": messages,
            "stream": true,
        }))
        .send()
        .await
        .map_err(|e| format!("chat failed: {e}. Is the local Hermes gateway running?"))?;

    let status = response.status();
    let status_code = status.as_u16();
    if !status.is_success() {
        let text = response_text_limited(response, MAX_AGENT_MODELS_RESPONSE)
            .await
            .map_err(|e| format!("read chat error response failed: {e}"))?;
        return Err(format!(
            "Hermes returned HTTP {status_code}: {}",
            truncate(&text, 360)
        ));
    }

    on_start()?;
    let mut buffer = String::new();
    let mut parse_state = StreamParseState::default();
    let mut produced = false;
    let mut received_bytes = 0usize;
    while let Some(chunk) = tokio::time::timeout(idle_timeout, response.chunk())
        .await
        .map_err(|_| stream_idle_timeout_message())?
        .map_err(|_| stream_read_failure_message())?
    {
        received_bytes = received_bytes.saturating_add(chunk.len());
        if received_bytes > MAX_AGENT_STREAM_BYTES {
            return Err(format!(
                "Hermes stream exceeded {MAX_AGENT_STREAM_BYTES} byte limit"
            ));
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        produced |= drain_sse_buffer(&mut buffer, &mut parse_state, on_event)?;
        if buffer.len() > MAX_AGENT_STREAM_BUFFER {
            return Err("Hermes stream contained an oversized event".to_string());
        }
    }
    if !buffer.trim().is_empty() {
        produced |= parse_sse_event(&buffer, &mut parse_state, on_event)?;
    }
    produced |= finish_stream_parse(&mut parse_state, on_event)?;
    // A stream that completes without ever emitting assistant text is a failure,
    // not an empty success — Hermes does this when the upstream model is rate
    // limited or unavailable and sends no content deltas. Without this the UI
    // would silently finish with a blank reply (and save nothing).
    if !produced {
        return Err(
            "The agent finished without returning any text. The model may be rate \
             limited or unavailable — check your Hermes usage limits and try again."
                .to_string(),
        );
    }
    Ok(())
}

fn stream_read_failure_message() -> String {
    "Hermes ended its response unexpectedly. This agent run was saved as failed; try again."
        .to_string()
}

fn stream_idle_timeout_message() -> String {
    "Hermes stopped sending updates for five minutes. This agent run was saved as failed; try again."
        .to_string()
}

pub fn parse_model_ids(value: &Value) -> Vec<String> {
    let Some(data) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = data
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

fn normalize_chat_messages(messages: Vec<AgentChatMessage>) -> Result<Vec<Value>, String> {
    if messages.len() > MAX_AGENT_MESSAGES {
        return Err(format!(
            "chat contains more than {MAX_AGENT_MESSAGES} messages"
        ));
    }
    let mut out = Vec::new();
    let mut total_bytes = 0usize;
    for message in messages {
        let role = message.role.trim().to_ascii_lowercase();
        if !matches!(role.as_str(), "system" | "user" | "assistant") {
            return Err(format!("unsupported chat role '{role}'"));
        }
        let content = message.content.trim();
        if content.is_empty() {
            continue;
        }
        total_bytes = total_bytes.saturating_add(content.len());
        if total_bytes > MAX_AGENT_INPUT_BYTES {
            return Err(format!(
                "chat input exceeds {MAX_AGENT_INPUT_BYTES} byte limit"
            ));
        }
        out.push(json!({
            "role": role,
            "content": content,
        }));
    }
    if out.is_empty() {
        return Err("message is required".to_string());
    }
    Ok(out)
}

fn message_content_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let parts = value.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                part.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

/// Drains complete SSE events from `buffer`. Returns `true` if any event
/// produced assistant text; propagates in-band Hermes errors as `Err`.
#[derive(Default)]
struct StreamParseState {
    tool_calls: BTreeMap<String, ToolCallStreamState>,
}

#[derive(Default)]
struct ToolCallStreamState {
    tool_call_id: Option<String>,
    tool_name: Option<String>,
    title: Option<String>,
    arguments: String,
    started: bool,
}

/// Drains complete SSE events from `buffer`. Returns `true` if any event
/// produced visible assistant activity; propagates in-band Hermes errors as
/// `Err`.
fn drain_sse_buffer<Event>(
    buffer: &mut String,
    state: &mut StreamParseState,
    on_event: &mut Event,
) -> Result<bool, String>
where
    Event: FnMut(AgentStreamEvent) -> Result<(), String>,
{
    let mut produced = false;
    while let Some(pos) = buffer.find("\n\n").or_else(|| buffer.find("\r\n\r\n")) {
        let event = buffer[..pos].to_string();
        let advance = if buffer[pos..].starts_with("\r\n\r\n") {
            pos + 4
        } else {
            pos + 2
        };
        buffer.replace_range(..advance, "");
        produced |= parse_sse_event(&event, state, on_event)?;
    }
    Ok(produced)
}

/// Parses one SSE event. Returns `true` if it emitted visible assistant
/// activity. Returns `Err` when the payload carries an in-band upstream error
/// (Hermes reports failures as HTTP 200 + an error body rather than a non-2xx
/// status).
fn parse_sse_event<Event>(
    event: &str,
    state: &mut StreamParseState,
    on_event: &mut Event,
) -> Result<bool, String>
where
    Event: FnMut(AgentStreamEvent) -> Result<(), String>,
{
    let data = event
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            line.strip_prefix("data:").map(str::trim)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let data = if data.trim().is_empty() && event.trim_start().starts_with('{') {
        event.trim()
    } else {
        data.trim()
    };
    if data.is_empty() || data == "[DONE]" {
        return Ok(false);
    }
    let parsed: Value =
        serde_json::from_str(data).map_err(|e| format!("parse chat stream failed: {e}"))?;
    if let Some(err) = upstream_error_message(&parsed) {
        return Err(err);
    }
    let mut produced = false;
    if let Some(reasoning) = parsed
        .pointer("/choices/0/delta/reasoning_content")
        .and_then(message_content_text)
        .or_else(|| {
            parsed
                .pointer("/choices/0/delta/reasoning")
                .and_then(message_content_text)
        })
        .or_else(|| {
            parsed
                .pointer("/choices/0/delta/thinking")
                .and_then(message_content_text)
        })
    {
        if !reasoning.is_empty() {
            on_event(AgentStreamEvent::reasoning_delta(reasoning))?;
            produced = true;
        }
    }
    if let Some(content) = parsed
        .pointer("/choices/0/delta/content")
        .and_then(message_content_text)
        .or_else(|| {
            parsed
                .pointer("/choices/0/message/content")
                .and_then(message_content_text)
        })
        .or_else(|| {
            parsed
                .pointer("/choices/0/text")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    {
        if !content.is_empty() {
            on_event(AgentStreamEvent::text_delta(content))?;
            produced = true;
        }
    }
    if let Some(tool_calls) = parsed.pointer("/choices/0/delta/tool_calls") {
        produced |= parse_tool_calls(tool_calls, state, on_event)?;
    }
    if let Some(tool_calls) = parsed.pointer("/choices/0/message/tool_calls") {
        produced |= parse_tool_calls(tool_calls, state, on_event)?;
    }
    Ok(produced)
}

fn parse_tool_calls<Event>(
    value: &Value,
    state: &mut StreamParseState,
    on_event: &mut Event,
) -> Result<bool, String>
where
    Event: FnMut(AgentStreamEvent) -> Result<(), String>,
{
    let Some(calls) = value.as_array() else {
        return Ok(false);
    };
    let mut produced = false;
    for call in calls {
        let index_key = call
            .get("index")
            .and_then(Value::as_i64)
            .map(|index| format!("index:{index}"));
        let id = call.get("id").and_then(Value::as_str).map(str::to_string);
        let key = index_key
            .or_else(|| id.as_ref().map(|id| format!("id:{id}")))
            .unwrap_or_else(|| format!("anon:{}", state.tool_calls.len()));
        let tool_name = call
            .pointer("/function/name")
            .and_then(Value::as_str)
            .or_else(|| call.get("name").and_then(Value::as_str))
            .map(str::to_string);
        let title = call
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string);
        let arguments_delta = call
            .pointer("/function/arguments")
            .and_then(Value::as_str)
            .or_else(|| call.get("arguments").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_default();
        let tool = state.tool_calls.entry(key).or_default();
        if tool.tool_call_id.is_none() {
            tool.tool_call_id = id;
        }
        if tool.tool_name.is_none() {
            tool.tool_name = tool_name;
        }
        if tool.title.is_none() {
            tool.title = title;
        }
        maybe_emit_tool_input_start(tool, on_event)?;
        if !arguments_delta.is_empty() {
            tool.arguments.push_str(&arguments_delta);
            if let Some(tool_call_id) = tool.tool_call_id.clone() {
                on_event(AgentStreamEvent::tool_input_delta(
                    tool_call_id,
                    arguments_delta,
                ))?;
                produced = true;
            }
        }
        produced |= tool.started;
    }
    Ok(produced)
}

fn maybe_emit_tool_input_start<Event>(
    tool: &mut ToolCallStreamState,
    on_event: &mut Event,
) -> Result<(), String>
where
    Event: FnMut(AgentStreamEvent) -> Result<(), String>,
{
    if tool.started {
        return Ok(());
    }
    let Some(tool_call_id) = tool.tool_call_id.clone() else {
        return Ok(());
    };
    let Some(tool_name) = tool.tool_name.clone() else {
        return Ok(());
    };
    on_event(AgentStreamEvent::tool_input_start(
        tool_call_id,
        tool_name,
        tool.title.clone(),
    ))?;
    tool.started = true;
    Ok(())
}

fn finish_stream_parse<Event>(
    state: &mut StreamParseState,
    on_event: &mut Event,
) -> Result<bool, String>
where
    Event: FnMut(AgentStreamEvent) -> Result<(), String>,
{
    let mut produced = false;
    for tool in state.tool_calls.values_mut() {
        if !tool.started {
            maybe_emit_tool_input_start(tool, on_event)?;
        }
        let (Some(tool_call_id), Some(tool_name)) =
            (tool.tool_call_id.clone(), tool.tool_name.clone())
        else {
            continue;
        };
        let input = parse_tool_input(&tool.arguments);
        on_event(AgentStreamEvent::tool_input_available(
            tool_call_id,
            tool_name,
            input,
            tool.title.clone(),
        ))?;
        produced = true;
    }
    state.tool_calls.clear();
    Ok(produced)
}

fn parse_tool_input(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return json!({});
    }
    serde_json::from_str(trimmed).unwrap_or_else(|_| Value::String(raw.to_string()))
}

/// Detects an in-band upstream failure in a Hermes/OpenAI-shaped payload.
/// Hermes returns HTTP 200 with an error body when the model run fails (e.g. a
/// 429 usage limit), so these never trip the non-2xx path.
fn upstream_error_message(parsed: &Value) -> Option<String> {
    // Hermes wrapper: { "hermes": { "failed": true, "error": "..." } }
    if let Some(hermes) = parsed.get("hermes") {
        if hermes.get("failed").and_then(Value::as_bool) == Some(true) {
            let detail = hermes
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("the model run failed");
            return Some(format!("Agent error: {detail}"));
        }
    }
    // OpenAI-style top-level error object.
    if let Some(detail) = parsed.pointer("/error/message").and_then(Value::as_str) {
        return Some(format!("Agent error: {detail}"));
    }
    // finish_reason: "error" carries the message in the choice's content.
    if parsed
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        == Some("error")
    {
        let detail = parsed
            .pointer("/choices/0/message/content")
            .and_then(message_content_text)
            .or_else(|| {
                parsed
                    .pointer("/choices/0/delta/content")
                    .and_then(message_content_text)
            })
            .unwrap_or_else(|| "the model run failed".to_string());
        return Some(format!("Agent error: {detail}"));
    }
    None
}

fn truncate(input: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in input.chars().take(max_chars) {
        out.push(ch);
    }
    if input.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

fn parse_message_blocks(body: &str) -> anyhow::Result<Vec<AgentVaultMessage>> {
    let mut messages = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find(MESSAGE_START) {
        let after_start = &rest[start + MESSAGE_START.len()..];
        let header_end = after_start
            .find("-->")
            .ok_or_else(|| anyhow!("agent message block is missing header close"))?;
        let meta_raw = after_start[..header_end].trim();
        let after_header = &after_start[header_end + 3..];
        let message_end = after_header
            .find(MESSAGE_END)
            .ok_or_else(|| anyhow!("agent message block is missing end marker"))?;
        let meta: AgentMessageMeta =
            serde_yaml::from_str(meta_raw).context("parse agent message metadata")?;
        validate_message_role(&meta.role)?;
        messages.push(AgentVaultMessage {
            id: if meta.id.trim().is_empty() {
                format!("msg-{}", Ulid::new().to_string().to_ascii_lowercase())
            } else {
                meta.id
            },
            role: meta.role,
            created_at: meta.created,
            content: trim_surrounding_newlines(&after_header[..message_end]).to_string(),
        });
        rest = &after_header[message_end + MESSAGE_END.len()..];
    }
    Ok(messages)
}

fn serialize_message_block(message: &AgentVaultMessage) -> String {
    let meta = AgentMessageMeta {
        id: if message.id.trim().is_empty() {
            format!("msg-{}", Ulid::new().to_string().to_ascii_lowercase())
        } else {
            message.id.clone()
        },
        role: normalized_message_role(&message.role),
        created: if message.created_at.trim().is_empty() {
            chrono::Local::now().to_rfc3339()
        } else {
            message.created_at.clone()
        },
    };
    let yaml = serde_yaml::to_string(&meta).unwrap_or_else(|_| {
        "id: msg-invalid\nrole: assistant\ncreated: 1970-01-01T00:00:00Z\n".to_string()
    });
    let content = message.content.trim_matches('\n');
    format!("{MESSAGE_START}\n{yaml}-->\n\n{content}\n\n{MESSAGE_END}")
}

fn validate_message_role(role: &str) -> anyhow::Result<()> {
    if matches!(
        role.trim().to_ascii_lowercase().as_str(),
        "system" | "user" | "assistant"
    ) {
        Ok(())
    } else {
        Err(anyhow!("unsupported agent message role '{}'", role))
    }
}

fn normalized_message_role(role: &str) -> String {
    let role = role.trim().to_ascii_lowercase();
    if matches!(role.as_str(), "system" | "user" | "assistant") {
        role
    } else {
        "assistant".to_string()
    }
}

fn display_name_or_default(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        default_display_name()
    } else {
        value.to_string()
    }
}

fn trim_surrounding_newlines(value: &str) -> &str {
    value.trim_matches(|c| c == '\n' || c == '\r')
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn default_base_url() -> String {
    DEFAULT_BASE_URL.to_string()
}

fn default_model() -> String {
    DEFAULT_MODEL.to_string()
}

fn default_session_key() -> String {
    DEFAULT_SESSION_KEY.to_string()
}

fn default_display_name() -> String {
    DEFAULT_DISPLAY_NAME.to_string()
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_base_url_trims_trailing_slash() {
        assert_eq!(
            normalize_base_url(" http://127.0.0.1:8644/v1/ ").unwrap(),
            "http://127.0.0.1:8644/v1"
        );
    }

    #[test]
    fn normalize_base_url_rejects_embedded_secrets_and_ambiguous_suffixes() {
        for url in [
            "file:///tmp/hermes.sock",
            "https://user:secret@example.com/v1",
            "https://example.com/v1?token=secret",
            "https://example.com/v1#fragment",
            "https://example.com/\nnext",
        ] {
            assert!(
                normalize_base_url(url).is_err(),
                "expected rejection: {url}"
            );
        }
    }

    #[test]
    fn normalize_chat_messages_enforces_request_budget() {
        let oversized = AgentChatMessage {
            role: "user".to_string(),
            content: "x".repeat(MAX_AGENT_INPUT_BYTES + 1),
        };
        assert!(normalize_chat_messages(vec![oversized]).is_err());
    }

    #[test]
    fn stream_read_failures_are_presented_as_recoverable_agent_errors() {
        let message = stream_read_failure_message();

        assert!(message.contains("ended its response unexpectedly"));
        assert!(message.contains("saved as failed"));
        assert!(!message.contains("error decoding response body"));
    }

    #[tokio::test]
    async fn active_stream_can_outlive_its_idle_timeout_window() {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            for payload in [
                "data: {\"choices\":[{\"delta\":{\"content\":\"Still \"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"working\"}}]}\n\n",
                "data: [DONE]\n\n",
            ] {
                let chunk = format!("{:x}\r\n{payload}\r\n", payload.len());
                if socket.write_all(chunk.as_bytes()).await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
        });

        let config = HermesConfigMeta {
            base_url: format!("http://{address}/v1"),
            ..HermesConfigMeta::default()
        };
        let input = AgentChatInput {
            conversation_id: "synthetic-stream".to_string(),
            messages: vec![AgentChatMessage {
                role: "user".to_string(),
                content: "Keep streaming synthetic output.".to_string(),
            }],
        };
        let mut started = false;
        let mut output = String::new();
        let result = chat_completion_stream_with_idle_timeout(
            &config,
            "synthetic-key",
            input,
            &mut || {
                started = true;
                Ok(())
            },
            &mut |event| {
                if event.kind == "delta" {
                    output.push_str(event.delta.as_deref().unwrap_or_default());
                }
                Ok(())
            },
            Duration::from_millis(200),
        )
        .await;
        server.await.unwrap();

        assert!(result.is_ok(), "active stream failed: {result:?}");
        assert!(started);
        assert_eq!(output, "Still working");
    }

    #[test]
    fn normalize_api_key_accepts_authorization_header() {
        assert_eq!(
            normalize_api_key("Authorization: Bearer abc123").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            normalize_api_key("Bearer abc123").as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn parse_model_ids_reads_openai_list_shape() {
        let value = json!({
            "object": "list",
            "data": [
                { "id": "cadence" },
                { "id": "other" },
                { "id": "cadence" }
            ]
        });
        assert_eq!(parse_model_ids(&value), vec!["cadence", "other"]);
    }

    #[test]
    fn message_content_text_accepts_string_or_parts() {
        assert_eq!(
            message_content_text(&json!("plain")).as_deref(),
            Some("plain")
        );
        assert_eq!(
            message_content_text(&json!([
                { "type": "text", "text": "hel" },
                { "type": "text", "text": "lo" },
                { "type": "image", "url": "ignored" }
            ]))
            .as_deref(),
            Some("hello")
        );
    }

    #[test]
    fn upstream_error_message_detects_hermes_429_payload() {
        // The exact shape Hermes returns when the upstream model is out of credits.
        let payload = json!({
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "API call failed after 3 retries: HTTP 429: The usage limit has been reached"
                },
                "finish_reason": "error"
            }],
            "hermes": {
                "failed": true,
                "error": "HTTP 429: The usage limit has been reached",
                "error_code": "agent_error"
            }
        });
        let message = upstream_error_message(&payload).expect("error detected");
        assert!(message.contains("usage limit"), "got: {message}");
    }

    #[test]
    fn upstream_error_message_ignores_normal_chunks() {
        let stop = json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] });
        assert!(upstream_error_message(&stop).is_none());
        let delta = json!({ "choices": [{ "delta": { "content": "hi" }, "finish_reason": null }] });
        assert!(upstream_error_message(&delta).is_none());
    }

    #[test]
    fn parse_sse_event_reports_produced_and_surfaces_errors() {
        let mut events = Vec::new();
        {
            let mut state = StreamParseState::default();
            let mut on_event = |event: AgentStreamEvent| {
                events.push(event);
                Ok(())
            };
            // Normal content delta -> produced = true.
            let produced = parse_sse_event(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hey\"}}]}",
                &mut state,
                &mut on_event,
            )
            .unwrap();
            assert!(produced);
            // [DONE] sentinel -> no content, no error.
            assert!(!parse_sse_event("data: [DONE]", &mut state, &mut on_event).unwrap());
            // In-band failure -> Err surfaced.
            let err = parse_sse_event(
                "data: {\"hermes\":{\"failed\":true,\"error\":\"HTTP 429: limit\"}}",
                &mut state,
                &mut on_event,
            )
            .unwrap_err();
            assert!(err.contains("429"), "got: {err}");
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "delta");
        assert_eq!(events[0].delta.as_deref(), Some("hey"));
    }

    #[test]
    fn parse_sse_event_forwards_reasoning_deltas() {
        let mut events = Vec::new();
        let mut state = StreamParseState::default();
        let mut on_event = |event: AgentStreamEvent| {
            events.push(event);
            Ok(())
        };

        let produced = parse_sse_event(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"checking files\"}}]}",
            &mut state,
            &mut on_event,
        )
        .unwrap();

        assert!(produced);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "reasoning-delta");
        assert_eq!(events[0].delta.as_deref(), Some("checking files"));
    }

    #[test]
    fn parse_sse_event_forwards_streamed_tool_calls() {
        let mut events = Vec::new();
        let mut state = StreamParseState::default();
        {
            let mut on_event = |event: AgentStreamEvent| {
                events.push(event);
                Ok(())
            };

            let first = parse_sse_event(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"search_vault\",\"arguments\":\"{\\\"query\\\"\"}}]}}]}",
                &mut state,
                &mut on_event,
            )
            .unwrap();
            let second = parse_sse_event(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":\\\"Hermes\\\"}\"}}]}}]}",
                &mut state,
                &mut on_event,
            )
            .unwrap();
            let finished = finish_stream_parse(&mut state, &mut on_event).unwrap();

            assert!(first);
            assert!(second);
            assert!(finished);
        }

        assert_eq!(events[0].kind, "tool-input-start");
        assert_eq!(events[0].tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(events[0].tool_name.as_deref(), Some("search_vault"));
        assert_eq!(events[1].kind, "tool-input-delta");
        assert_eq!(events[2].kind, "tool-input-delta");
        assert_eq!(events[3].kind, "tool-input-available");
        assert_eq!(events[3].input, Some(json!({ "query": "Hermes" })));
    }

    #[test]
    fn agent_chat_markdown_round_trips_messages() {
        let chat = AgentChatRecord {
            id: "agent-01h".to_string(),
            path: "agent/agent-01h.md".to_string(),
            title: "Loose threads".to_string(),
            agent: "Hermes".to_string(),
            model: "cadence".to_string(),
            created: "2026-06-13T12:00:00-07:00".to_string(),
            updated: "2026-06-13T12:01:00-07:00".to_string(),
            pinned: true,
            tags: vec!["agent".to_string()],
            context: Some(AgentChatContext {
                title: "June 20, 2026".to_string(),
                route: "/cadence/2026-06-20".to_string(),
            }),
            messages: vec![
                AgentVaultMessage {
                    id: "m1".to_string(),
                    role: "user".to_string(),
                    created_at: "2026-06-13T12:00:00-07:00".to_string(),
                    content: "Find loose threads.".to_string(),
                },
                AgentVaultMessage {
                    id: "m2".to_string(),
                    role: "assistant".to_string(),
                    created_at: "2026-06-13T12:01:00-07:00".to_string(),
                    content: "Start with [[Woodshed]].".to_string(),
                },
            ],
        };
        let raw = serialize_chat(&chat).unwrap();
        assert!(raw.contains("type: agent_chat"));
        let parsed = parse_chat(&raw, "agent/agent-01h.md").unwrap();
        assert_eq!(parsed.title, "Loose threads");
        assert!(parsed.pinned);
        let context = parsed.context.expect("context round-trips");
        assert_eq!(context.title, "June 20, 2026");
        assert_eq!(context.route, "/cadence/2026-06-20");
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[1].content, "Start with [[Woodshed]].");
    }

    #[test]
    fn hermes_config_never_serializes_legacy_api_key() {
        let meta = HermesConfigMeta {
            display_name: "Hermes".to_string(),
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            session_key: DEFAULT_SESSION_KEY.to_string(),
            api_key: Some("Bearer local-secret".to_string()),
            api_key_configured: true,
        };

        let raw = serde_json::to_string(&meta).unwrap();
        let serialized: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(serialized.get("apiKey").is_none());
        assert!(!raw.contains("local-secret"));

        let parsed: HermesConfigMeta = serde_json::from_str(&raw).unwrap();
        assert!(parsed.api_key.is_none());

        let public = public_config(parsed, CredentialSource::Missing);
        assert!(public.has_api_key);
        assert_eq!(public.credential_source, CredentialSource::Missing);
        let public_raw = serde_json::to_string(&public).unwrap();
        let public_serialized: serde_json::Value = serde_json::from_str(&public_raw).unwrap();
        assert!(public_serialized.get("apiKey").is_none());
        assert!(!public_raw.contains("local-secret"));
    }
}
