use crate::agent::{
    self, AgentChatCreateInput, AgentChatInput, AgentChatRecord, AgentChatStreamEvent,
    AgentChatStreamInput, AgentChatSummary, AgentChatUpdateInput, AgentConfig, AgentConfigInput,
    AgentConnectionTestResult, HermesConfigMeta,
};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";

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
