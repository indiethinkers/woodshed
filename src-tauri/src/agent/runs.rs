use super::{AgentChatMessage, AgentStreamEvent, AgentVaultMessage};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use ulid::Ulid;

pub const RUNS_DIR: &str = "agent-runs";
const MAX_RUN_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecord {
    pub id: String,
    pub conversation_id: String,
    pub session_id: String,
    pub idempotency_key: String,
    pub assistant_message_id: String,
    pub status: AgentRunStatus,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub input_message: AgentVaultMessage,
    pub request_messages: Vec<AgentChatMessage>,
    pub events: Vec<AgentStreamEvent>,
    pub final_response: Option<String>,
    pub error: Option<String>,
    pub retry_of: Option<String>,
    #[serde(default)]
    pub transcript_finalized_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewAgentRun {
    pub conversation_id: String,
    pub idempotency_key: String,
    pub input_message: AgentVaultMessage,
    pub request_messages: Vec<AgentChatMessage>,
    pub retry_of: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunCreateInput {
    pub conversation_id: String,
    pub idempotency_key: String,
    pub input_message: AgentVaultMessage,
    pub messages: Vec<AgentChatMessage>,
    #[serde(default)]
    pub retry_of: Option<String>,
}

impl From<AgentRunCreateInput> for NewAgentRun {
    fn from(input: AgentRunCreateInput) -> Self {
        Self {
            conversation_id: input.conversation_id,
            idempotency_key: input.idempotency_key,
            input_message: input.input_message,
            request_messages: input.messages,
            retry_of: input.retry_of,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunDto {
    pub id: String,
    pub conversation_id: String,
    pub session_id: String,
    pub assistant_message_id: String,
    pub status: AgentRunStatus,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub input_message: AgentVaultMessage,
    pub events: Vec<AgentStreamEvent>,
    pub final_response: Option<String>,
    pub error: Option<String>,
    pub retry_of: Option<String>,
}

impl From<&AgentRunRecord> for AgentRunDto {
    fn from(run: &AgentRunRecord) -> Self {
        Self {
            id: run.id.clone(),
            conversation_id: run.conversation_id.clone(),
            session_id: run.session_id.clone(),
            assistant_message_id: run.assistant_message_id.clone(),
            status: run.status,
            created_at: run.created_at.clone(),
            updated_at: run.updated_at.clone(),
            started_at: run.started_at.clone(),
            finished_at: run.finished_at.clone(),
            input_message: run.input_message.clone(),
            events: run.events.clone(),
            final_response: run.final_response.clone(),
            error: run.error.clone(),
            retry_of: run.retry_of.clone(),
        }
    }
}

pub fn create_or_get(
    app_data_dir: &Path,
    input: NewAgentRun,
    now: &str,
) -> Result<(AgentRunRecord, bool), String> {
    validate_new_run(&input)?;
    for run in read_all(app_data_dir)? {
        if run.conversation_id == input.conversation_id
            && run.idempotency_key == input.idempotency_key
        {
            return Ok((run, false));
        }
    }

    let id = format!("agent-run-{}", Ulid::new().to_string().to_ascii_lowercase());
    let assistant_message_id = format!(
        "agent-response-{}",
        Ulid::new().to_string().to_ascii_lowercase()
    );
    let run = AgentRunRecord {
        id,
        session_id: input.conversation_id.clone(),
        conversation_id: input.conversation_id,
        idempotency_key: input.idempotency_key,
        assistant_message_id,
        status: AgentRunStatus::Queued,
        created_at: now.to_string(),
        updated_at: now.to_string(),
        started_at: None,
        finished_at: None,
        input_message: input.input_message,
        request_messages: input.request_messages,
        events: Vec::new(),
        final_response: None,
        error: None,
        retry_of: input.retry_of,
        transcript_finalized_at: None,
    };
    write(app_data_dir, &run)?;
    Ok((run, true))
}

pub fn read(app_data_dir: &Path, run_id: &str) -> Result<Option<AgentRunRecord>, String> {
    crate::vault::validate_record_id(run_id)?;
    let path = run_path(app_data_dir, run_id);
    if !path.exists() {
        return Ok(None);
    }
    read_path(&path).map(Some)
}

pub fn read_all(app_data_dir: &Path) -> Result<Vec<AgentRunRecord>, String> {
    let dir = runs_dir(app_data_dir)?;
    let mut runs = Vec::new();
    for entry in
        std::fs::read_dir(&dir).map_err(|error| format!("read agent runs directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("read agent run entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json")
            || !crate::vault::is_real_file(&path)
        {
            continue;
        }
        runs.push(read_path(&path)?);
    }
    Ok(runs)
}

pub fn list_for_conversation(
    app_data_dir: &Path,
    conversation_id: &str,
    limit: usize,
) -> Result<Vec<AgentRunRecord>, String> {
    let mut runs = read_all(app_data_dir)?
        .into_iter()
        .filter(|run| run.conversation_id == conversation_id)
        .collect::<Vec<_>>();
    runs.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    runs.truncate(limit);
    Ok(runs)
}

pub fn list_active_by_ids(
    app_data_dir: &Path,
    run_ids: &[String],
) -> Result<Vec<AgentRunRecord>, String> {
    let mut ids = run_ids.to_vec();
    ids.sort_unstable_by(|left, right| right.cmp(left));
    ids.dedup();
    ids.truncate(20);

    let mut runs = Vec::with_capacity(ids.len());
    for run_id in ids {
        if let Some(run) = read(app_data_dir, &run_id)? {
            if is_active(run.status) {
                runs.push(run);
            }
        }
    }
    runs.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(runs)
}

pub fn mark_running(
    app_data_dir: &Path,
    run_id: &str,
    now: &str,
) -> Result<AgentRunRecord, String> {
    update(app_data_dir, run_id, |run| {
        if run.status == AgentRunStatus::Queued {
            run.status = AgentRunStatus::Running;
            run.started_at = Some(now.to_string());
            run.updated_at = now.to_string();
        }
    })
}

pub fn append_events(
    app_data_dir: &Path,
    run_id: &str,
    events: Vec<AgentStreamEvent>,
    now: &str,
) -> Result<AgentRunRecord, String> {
    update(app_data_dir, run_id, |run| {
        if is_active(run.status) && !events.is_empty() {
            run.events.extend(events);
            run.updated_at = now.to_string();
        }
    })
}

pub fn complete(
    app_data_dir: &Path,
    run_id: &str,
    final_response: &str,
    now: &str,
) -> Result<AgentRunRecord, String> {
    update(app_data_dir, run_id, |run| {
        if is_active(run.status) {
            run.status = AgentRunStatus::Completed;
            run.final_response = Some(final_response.to_string());
            run.error = None;
            run.updated_at = now.to_string();
            run.finished_at = Some(now.to_string());
        }
    })
}

pub fn fail(
    app_data_dir: &Path,
    run_id: &str,
    error: &str,
    now: &str,
) -> Result<AgentRunRecord, String> {
    update(app_data_dir, run_id, |run| {
        if is_active(run.status) {
            run.status = AgentRunStatus::Failed;
            run.error = Some(error.to_string());
            run.updated_at = now.to_string();
            run.finished_at = Some(now.to_string());
        }
    })
}

pub fn cancel(app_data_dir: &Path, run_id: &str, now: &str) -> Result<AgentRunRecord, String> {
    update(app_data_dir, run_id, |run| {
        if is_active(run.status) {
            run.status = AgentRunStatus::Cancelled;
            run.error = None;
            run.updated_at = now.to_string();
            run.finished_at = Some(now.to_string());
        }
    })
}

pub fn mark_transcript_finalized(
    app_data_dir: &Path,
    run_id: &str,
    now: &str,
) -> Result<AgentRunRecord, String> {
    update(app_data_dir, run_id, |run| {
        if run.status == AgentRunStatus::Completed && run.transcript_finalized_at.is_none() {
            run.transcript_finalized_at = Some(now.to_string());
            run.updated_at = now.to_string();
        }
    })
}

pub fn recover_stale(
    app_data_dir: &Path,
    run_id: &str,
    is_live: bool,
    now: &str,
) -> Result<AgentRunRecord, String> {
    if is_live {
        return read(app_data_dir, run_id)?.ok_or_else(|| format!("agent run not found: {run_id}"));
    }
    fail(
        app_data_dir,
        run_id,
        "Woodshed restarted before this agent run finished. Send the message again to retry.",
        now,
    )
}

pub fn ensure_user_message_once(chat: &mut super::AgentChatRecord, run: &AgentRunRecord) -> bool {
    if chat
        .messages
        .iter()
        .any(|message| message.id == run.input_message.id)
    {
        return false;
    }
    chat.messages.push(run.input_message.clone());
    true
}

pub fn finalize_chat_once(chat: &mut super::AgentChatRecord, run: &AgentRunRecord) -> bool {
    let Some(content) = run.final_response.as_ref() else {
        return false;
    };
    let created_at = run
        .finished_at
        .as_deref()
        .unwrap_or(run.updated_at.as_str())
        .to_string();
    if let Some(message) = chat
        .messages
        .iter_mut()
        .find(|message| message.id == run.assistant_message_id)
    {
        if message.content == *content {
            return false;
        }
        message.content = content.clone();
        message.created_at = created_at;
        return true;
    }
    chat.messages.push(AgentVaultMessage {
        id: run.assistant_message_id.clone(),
        role: "assistant".to_string(),
        created_at,
        content: content.clone(),
    });
    true
}

pub fn write(app_data_dir: &Path, run: &AgentRunRecord) -> Result<(), String> {
    crate::vault::validate_record_id(&run.id)?;
    let payload =
        serde_json::to_vec_pretty(run).map_err(|error| format!("serialize agent run: {error}"))?;
    if payload.len() > MAX_RUN_BYTES {
        return Err("agent run exceeds the 16 MiB storage limit".to_string());
    }
    let dir = runs_dir(app_data_dir)?;
    crate::vault::write_binary_atomic(&dir.join(format!("{}.json", run.id)), &payload)
        .map_err(|error| format!("write agent run: {error:#}"))
}

fn validate_new_run(input: &NewAgentRun) -> Result<(), String> {
    crate::vault::validate_record_id(input.conversation_id.trim())?;
    if input.idempotency_key.trim().is_empty()
        || input.idempotency_key.len() > 200
        || input.idempotency_key.chars().any(char::is_control)
    {
        return Err("agent run idempotency key is invalid".to_string());
    }
    if !input.input_message.role.eq_ignore_ascii_case("user") {
        return Err("agent run input message must have the user role".to_string());
    }
    if input.input_message.id.trim().is_empty() || input.input_message.content.trim().is_empty() {
        return Err("agent run input message is incomplete".to_string());
    }
    if input.request_messages.is_empty() {
        return Err("agent run request messages cannot be empty".to_string());
    }
    if let Some(retry_of) = input.retry_of.as_deref() {
        crate::vault::validate_record_id(retry_of)?;
    }
    Ok(())
}

fn update(
    app_data_dir: &Path,
    run_id: &str,
    mutate: impl FnOnce(&mut AgentRunRecord),
) -> Result<AgentRunRecord, String> {
    let mut run =
        read(app_data_dir, run_id)?.ok_or_else(|| format!("agent run not found: {run_id}"))?;
    mutate(&mut run);
    write(app_data_dir, &run)?;
    Ok(run)
}

pub fn is_active(status: AgentRunStatus) -> bool {
    matches!(status, AgentRunStatus::Queued | AgentRunStatus::Running)
}

fn runs_dir(app_data_dir: &Path) -> Result<PathBuf, String> {
    let dir = app_data_dir.join(RUNS_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("create agent runs directory: {error}"))?;
    if !crate::vault::is_real_directory(&dir) {
        return Err("agent runs path must be a real directory".to_string());
    }
    Ok(dir)
}

fn run_path(app_data_dir: &Path, run_id: &str) -> PathBuf {
    app_data_dir.join(RUNS_DIR).join(format!("{run_id}.json"))
}

fn read_path(path: &Path) -> Result<AgentRunRecord, String> {
    let content =
        crate::vault::read_record(path).map_err(|error| format!("read agent run: {error:#}"))?;
    serde_json::from_str(&content).map_err(|error| format!("parse agent run: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat() -> super::super::AgentChatRecord {
        super::super::AgentChatRecord {
            id: "agent-conversation-1".to_string(),
            path: "agent/agent-conversation-1.md".to_string(),
            title: "Reference review".to_string(),
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

    fn input() -> NewAgentRun {
        NewAgentRun {
            conversation_id: "agent-conversation-1".to_string(),
            idempotency_key: "user-message-1".to_string(),
            input_message: AgentVaultMessage {
                id: "user-message-1".to_string(),
                role: "user".to_string(),
                created_at: "2031-02-03T12:00:00Z".to_string(),
                content: "Review the reference.".to_string(),
            },
            request_messages: vec![AgentChatMessage {
                role: "user".to_string(),
                content: "Review the reference.".to_string(),
            }],
            retry_of: None,
        }
    }

    #[test]
    fn create_returns_a_stable_queued_run_and_deduplicates_retries() {
        let temp = tempfile::tempdir().unwrap();
        let now = "2031-02-03T12:00:00Z";

        let (created, was_created) = create_or_get(temp.path(), input(), now).unwrap();
        let (retried, was_created_again) =
            create_or_get(temp.path(), input(), "2031-02-03T12:00:01Z").unwrap();

        assert!(was_created);
        assert!(!was_created_again);
        assert_eq!(created.id, retried.id);
        assert_eq!(created.status, AgentRunStatus::Queued);
        assert_eq!(created.conversation_id, "agent-conversation-1");
        assert_eq!(created.session_id, "agent-conversation-1");
        assert!(created.id.starts_with("agent-run-"));
        assert!(temp
            .path()
            .join(RUNS_DIR)
            .join(format!("{}.json", created.id))
            .is_file());
    }

    #[test]
    fn reconnect_lists_an_existing_active_run_for_its_conversation() {
        let temp = tempfile::tempdir().unwrap();
        let (run, _) = create_or_get(temp.path(), input(), "2031-02-03T12:00:00Z").unwrap();

        mark_running(temp.path(), &run.id, "2031-02-03T12:00:01Z").unwrap();
        append_events(
            temp.path(),
            &run.id,
            vec![AgentStreamEvent::text_delta("Partial answer".to_string())],
            "2031-02-03T12:00:02Z",
        )
        .unwrap();
        let runs = list_for_conversation(temp.path(), "agent-conversation-1", 20).unwrap();

        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, run.id);
        assert_eq!(runs[0].status, AgentRunStatus::Running);
        assert_eq!(runs[0].events.len(), 1);
    }

    #[test]
    fn active_queue_reads_only_supplied_live_run_ids() {
        let temp = tempfile::tempdir().unwrap();
        let (older, _) = create_or_get(temp.path(), input(), "2031-02-03T12:00:00Z").unwrap();
        mark_running(temp.path(), &older.id, "2031-02-03T12:00:01Z").unwrap();

        let mut newer_input = input();
        newer_input.conversation_id = "agent-conversation-2".to_string();
        newer_input.idempotency_key = "user-message-2".to_string();
        newer_input.input_message.id = "user-message-2".to_string();
        let (newer, _) = create_or_get(temp.path(), newer_input, "2031-02-03T12:01:00Z").unwrap();

        complete(
            temp.path(),
            &older.id,
            "Finished response.",
            "2031-02-03T12:02:00Z",
        )
        .unwrap();

        std::fs::write(
            temp.path().join(RUNS_DIR).join("agent-run-corrupt.json"),
            b"not json",
        )
        .unwrap();

        let active = list_active_by_ids(temp.path(), std::slice::from_ref(&newer.id)).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, newer.id);
        assert_eq!(active[0].conversation_id, "agent-conversation-2");
    }

    #[test]
    fn terminal_state_and_error_are_durable() {
        let temp = tempfile::tempdir().unwrap();
        let (run, _) = create_or_get(temp.path(), input(), "2031-02-03T12:00:00Z").unwrap();

        fail(
            temp.path(),
            &run.id,
            "The local agent was unavailable.",
            "2031-02-03T12:00:02Z",
        )
        .unwrap();
        let stored = read(temp.path(), &run.id).unwrap().unwrap();

        assert_eq!(stored.status, AgentRunStatus::Failed);
        assert_eq!(
            stored.error.as_deref(),
            Some("The local agent was unavailable.")
        );
        assert_eq!(stored.finished_at.as_deref(), Some("2031-02-03T12:00:02Z"));
    }

    #[test]
    fn cancellation_is_terminal_for_queued_and_running_runs() {
        let temp = tempfile::tempdir().unwrap();
        let (queued, _) = create_or_get(temp.path(), input(), "2031-02-03T12:00:00Z").unwrap();
        let cancelled = cancel(temp.path(), &queued.id, "2031-02-03T12:00:01Z").unwrap();
        assert_eq!(cancelled.status, AgentRunStatus::Cancelled);

        let mut second = input();
        second.idempotency_key = "user-message-2".to_string();
        second.input_message.id = "user-message-2".to_string();
        let (running, _) = create_or_get(temp.path(), second, "2031-02-03T12:00:02Z").unwrap();
        mark_running(temp.path(), &running.id, "2031-02-03T12:00:03Z").unwrap();
        let cancelled = cancel(temp.path(), &running.id, "2031-02-03T12:00:04Z").unwrap();
        assert_eq!(cancelled.status, AgentRunStatus::Cancelled);

        let after_late_completion = complete(
            temp.path(),
            &running.id,
            "This response arrived too late.",
            "2031-02-03T12:00:05Z",
        )
        .unwrap();
        assert_eq!(after_late_completion.status, AgentRunStatus::Cancelled);
        assert!(after_late_completion.final_response.is_none());
    }

    #[test]
    fn stale_active_runs_fail_instead_of_remaining_running_forever() {
        let temp = tempfile::tempdir().unwrap();
        let (run, _) = create_or_get(temp.path(), input(), "2031-02-03T12:00:00Z").unwrap();
        mark_running(temp.path(), &run.id, "2031-02-03T12:00:01Z").unwrap();

        let recovered = recover_stale(temp.path(), &run.id, false, "2031-02-03T12:05:00Z").unwrap();

        assert_eq!(recovered.status, AgentRunStatus::Failed);
        assert!(recovered.error.unwrap().contains("restarted"));
    }

    #[test]
    fn finalizing_twice_writes_exactly_one_assistant_message() {
        let temp = tempfile::tempdir().unwrap();
        let (run, _) = create_or_get(temp.path(), input(), "2031-02-03T12:00:00Z").unwrap();
        let completed = complete(
            temp.path(),
            &run.id,
            "The reference is ready.",
            "2031-02-03T12:00:05Z",
        )
        .unwrap();
        let mut chat = chat();

        finalize_chat_once(&mut chat, &completed);
        finalize_chat_once(&mut chat, &completed);

        let assistant_messages = chat
            .messages
            .iter()
            .filter(|message| message.id == completed.assistant_message_id)
            .collect::<Vec<_>>();
        assert_eq!(assistant_messages.len(), 1);
        assert_eq!(assistant_messages[0].content, "The reference is ready.");
    }

    #[test]
    fn create_rejects_invalid_ids_roles_empty_requests_and_oversized_records() {
        let temp = tempfile::tempdir().unwrap();

        let mut invalid_id = input();
        invalid_id.conversation_id = "../outside".to_string();
        assert!(create_or_get(temp.path(), invalid_id, "2031-02-03T12:00:00Z").is_err());

        let mut invalid_role = input();
        invalid_role.input_message.role = "assistant".to_string();
        assert!(create_or_get(temp.path(), invalid_role, "2031-02-03T12:00:00Z").is_err());

        let mut empty_request = input();
        empty_request.request_messages.clear();
        assert!(create_or_get(temp.path(), empty_request, "2031-02-03T12:00:00Z").is_err());

        let mut oversized = input();
        oversized.request_messages[0].content = "x".repeat(MAX_RUN_BYTES);
        assert!(create_or_get(temp.path(), oversized, "2031-02-03T12:00:00Z").is_err());
    }

    #[test]
    fn malformed_run_json_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(RUNS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agent-run-corrupt.json"), b"not json").unwrap();

        assert!(read(temp.path(), "agent-run-corrupt").is_err());
        assert!(read_all(temp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn run_storage_refuses_a_symlinked_directory() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, temp.path().join(RUNS_DIR)).unwrap();

        assert!(create_or_get(temp.path(), input(), "2031-02-03T12:00:00Z").is_err());
        assert!(outside.read_dir().unwrap().next().is_none());
    }
}
