//! Inbox Sweep commands.
//!
//! Thin wrappers over the pure logic in `crate::sweep`. The triage command is
//! the heart: it reads the live email locally (the "push" source — the email
//! may not be committed to git), pushes its text to Hermes (which reads its own
//! vault clone for background context), parses the structured result, and
//! writes a `sweep/<id>.md` card. All card state lives on disk; the watcher
//! repaints the UI.

use crate::agent::{self, AgentChatInput, AgentChatMessage, HermesConfigMeta};
use crate::commands::mail::{mail_get_local, EmailSummary};
use crate::sweep::{
    self, CommandPlanOutput, NewCardInput, SweepActionKind, SweepCard, SweepStatus,
    TriagePromptInput,
};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::AppState;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";

#[tauri::command]
pub fn sweep_cards_all(app: AppHandle) -> Result<Vec<SweepCard>, String> {
    let vault = vault_root(&app)?;
    let dir = vault_lib::sweep_dir(&vault);
    if !vault_lib::is_real_directory(&dir) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !vault_lib::is_real_file(&path)
        {
            continue;
        }
        match read_card(&vault, &path) {
            Ok(card) => out.push(card),
            Err(e) => eprintln!("skipping sweep card {}: {}", path.display(), e),
        }
    }
    // Newest activity first.
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(out)
}

/// Persist an edited card (e.g. the user tweaked the draft in the textarea, or
/// the frontend changed its lane).
#[tauri::command]
pub fn sweep_card_save(
    app: AppHandle,
    state: State<AppState>,
    mut card: SweepCard,
) -> Result<SweepCard, String> {
    let vault = vault_root(&app)?;
    card.updated = chrono::Local::now().to_rfc3339();
    let path = card_path(&vault, &card.id)?;
    write_card(&state, &path, &card)?;
    card.path = crate::index::rel_path_str(&vault, &path);
    Ok(card)
}

/// Triage one inbox email: push it to Hermes, parse the result, write the card.
#[tauri::command]
pub async fn sweep_triage_email(
    app: AppHandle,
    state: State<'_, AppState>,
    email_id: String,
) -> Result<SweepCard, String> {
    let vault = vault_root(&app)?;
    let email = mail_get_local(app.clone(), email_id.clone())?
        .ok_or_else(|| format!("email not found: {email_id}"))?;

    let meta = read_meta(&app)?;
    let api_key = agent::key::resolve(&meta).map_err(|e| e.to_string())?;
    let voice_samples = sweep::notebook_voice_samples(&vault);
    let prompt = sweep::build_triage_prompt(&TriagePromptInput {
        from: &email.from,
        from_email: &email.from_email,
        subject: &email.subject,
        thread_id: &email.thread_id,
        mentions: &email.mentions,
        body: &email.body,
        voice_samples: &voice_samples,
    });
    let input = AgentChatInput {
        conversation_id: format!("sweep-{}", email.id),
        messages: vec![AgentChatMessage {
            role: "user".to_string(),
            content: prompt,
        }],
    };
    let response = agent::chat_completion(&meta, &api_key, input).await?;
    let triage = sweep::extract_triage_json(&response.content).map_err(|e| format!("{:#}", e))?;

    // One card per email: reuse the existing file (preserving id/created/
    // timeline) when this email has been swept before.
    let mut card = match find_card_by_email(&vault, &email.id)? {
        Some(mut existing) => {
            sweep::apply_triage(&mut existing, triage, false);
            existing
        }
        None => sweep::new_card(new_card_input(&email), triage),
    };
    let path = card_path(&vault, &card.id)?;
    write_card(&state, &path, &card)?;
    card.path = crate::index::rel_path_str(&vault, &path);
    Ok(card)
}

/// Re-draft a card from the "talk to the card" command bar: push the email +
/// current draft + the user's instruction to Hermes, replace the draft.
#[tauri::command]
pub async fn sweep_card_refine(
    app: AppHandle,
    state: State<'_, AppState>,
    card_id: String,
    instruction: String,
) -> Result<SweepCard, String> {
    let vault = vault_root(&app)?;
    let path = card_path(&vault, &card_id)?;
    if !path.exists() {
        return Err(format!("sweep card not found: {card_id}"));
    }
    let mut card = read_card(&vault, &path)?;
    let email = mail_get_local(app.clone(), card.email_id.clone())?;
    let (from, subject, body) = match &email {
        Some(e) => (e.from.as_str(), e.subject.as_str(), e.body.as_str()),
        None => (card.from.as_str(), card.subject.as_str(), ""),
    };

    let meta = read_meta(&app)?;
    let api_key = agent::key::resolve(&meta).map_err(|e| e.to_string())?;
    let voice_samples = sweep::notebook_voice_samples(&vault);
    let prompt = sweep::build_refine_prompt(&sweep::RefinePromptInput {
        from,
        subject,
        body,
        current_draft: &card.draft,
        instruction: &instruction,
        voice_samples: &voice_samples,
    });
    let input = AgentChatInput {
        conversation_id: format!("sweep-refine-{}", card.id),
        messages: vec![AgentChatMessage {
            role: "user".to_string(),
            content: prompt,
        }],
    };
    let response = agent::chat_completion(&meta, &api_key, input).await?;

    card.draft = response.content.trim().to_string();
    if !card.draft.trim().is_empty() {
        if let Some(kind) = sweep::requested_draft_action(&instruction) {
            card.action_kind = kind;
            card.action_label = match kind {
                SweepActionKind::Forward => "Draft forward",
                _ => "Draft reply",
            }
            .to_string();
        }
    }
    card.status = SweepStatus::ToReview;
    sweep::push_event(&mut card, "you", "redrafted", Some(instruction));
    write_card(&state, &path, &card)?;
    card.path = crate::index::rel_path_str(&vault, &path);
    Ok(card)
}

/// Translate a freeform command-bar request into executable actions.
#[tauri::command]
pub async fn sweep_card_plan_actions(
    app: AppHandle,
    card_id: String,
    instruction: String,
) -> Result<CommandPlanOutput, String> {
    let vault = vault_root(&app)?;
    let path = card_path(&vault, &card_id)?;
    if !path.exists() {
        return Err(format!("sweep card not found: {card_id}"));
    }
    let card = read_card(&vault, &path)?;
    let email = mail_get_local(app.clone(), card.email_id.clone())?;
    let (from, subject, body) = match &email {
        Some(e) => (e.from.as_str(), e.subject.as_str(), e.body.as_str()),
        None => (card.from.as_str(), card.subject.as_str(), ""),
    };

    let today = chrono::Local::now().date_naive().to_string();
    let meta = read_meta(&app)?;
    let api_key = agent::key::resolve(&meta).map_err(|e| e.to_string())?;
    let prompt = sweep::build_command_plan_prompt(&sweep::CommandPlanPromptInput {
        from,
        subject,
        body,
        headline: &card.headline,
        summary: &card.summary,
        what_happened: &card.what_happened,
        instruction: &instruction,
        today: &today,
    });
    let input = AgentChatInput {
        conversation_id: format!("sweep-plan-{}", card.id),
        messages: vec![AgentChatMessage {
            role: "user".to_string(),
            content: prompt,
        }],
    };
    let response = agent::chat_completion(&meta, &api_key, input).await?;
    sweep::extract_command_plan_json(&response.content).map_err(|e| format!("{:#}", e))
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn new_card_input(email: &EmailSummary) -> NewCardInput {
    NewCardInput {
        email_id: email.id.clone(),
        thread_id: non_empty(&email.thread_id),
        inbox: non_empty(&email.inbox),
        from: email.from.clone(),
        subject: email.subject.clone(),
        email_date: non_empty(&email.date),
    }
}

/// Delete stale `to_review` cards whose source email is no longer in
/// `inbox/`. Such cards are orphans: the email was archived/handled
/// elsewhere (most often directly in Gmail, then reconciled out of the
/// local inbox), but its untriaged card lingered and kept showing up in
/// the sweep's Review lane. Only `to_review` cards are pruned — cards in
/// queued/working/done reflect actions taken inside Woodshed and stay as
/// history even after their email leaves the inbox. Returns the count
/// removed.
#[tauri::command]
pub fn sweep_discard_orphans(app: AppHandle, state: State<AppState>) -> Result<usize, String> {
    let vault = vault_root(&app)?;
    let dir = vault_lib::sweep_dir(&vault);
    if !vault_lib::is_real_directory(&dir) {
        return Ok(0);
    }

    // Set of ids currently in the local inbox (normalized to match the id
    // form stored on cards).
    let inbox_ids: std::collections::HashSet<String> =
        crate::commands::mail::read_inbox_dir(&vault.join("inbox"))
            .into_iter()
            .map(|email| crate::commands::mail::strip_brackets(&email.id))
            .collect();

    let mut removed = 0usize;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !vault_lib::is_real_file(&path)
        {
            continue;
        }
        let Ok(card) = read_card(&vault, &path) else {
            continue;
        };
        if card.status != SweepStatus::ToReview {
            continue;
        }
        if inbox_ids.contains(&crate::commands::mail::strip_brackets(&card.email_id)) {
            continue;
        }
        if let Some(watcher) = state.watcher.lock_recover().as_ref() {
            watcher.record_self_write(&path);
        }
        match vault_lib::move_to_trash(&vault, &path) {
            Ok(Some(_)) => removed += 1,
            Ok(None) => {}
            Err(e) => eprintln!("sweep prune: failed to trash {}: {e}", path.display()),
        }
    }
    Ok(removed)
}

fn find_card_by_email(vault: &Path, email_id: &str) -> Result<Option<SweepCard>, String> {
    let dir = vault_lib::sweep_dir(vault);
    if !vault_lib::is_real_directory(&dir) {
        return Ok(None);
    }
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md")
            || !vault_lib::is_real_file(&path)
        {
            continue;
        }
        if let Ok(card) = read_card(vault, &path) {
            if card.email_id == email_id {
                return Ok(Some(card));
            }
        }
    }
    Ok(None)
}

fn card_path(vault: &Path, id: &str) -> Result<PathBuf, String> {
    vault_lib::record_file_path(vault, vault_lib::SWEEP_DIR, id)
}

fn read_card(vault: &Path, abs: &Path) -> Result<SweepCard, String> {
    let content = vault_lib::read_record(abs).map_err(|e| e.to_string())?;
    let rel = crate::index::rel_path_str(vault, abs);
    sweep::parse_card(&content, &rel).map_err(|e| format!("{:#}", e))
}

fn write_card(state: &State<AppState>, abs: &Path, card: &SweepCard) -> Result<(), String> {
    let serialized = sweep::serialize_card(card).map_err(|e| format!("{:#}", e))?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs);
    }
    vault_lib::write_atomic(abs, &serialized).map_err(|e| e.to_string())?;
    Ok(())
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

fn read_meta(app: &AppHandle) -> Result<HermesConfigMeta, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    match store.get(agent::STORE_KEY) {
        Some(value) => serde_json::from_value(value).map_err(|e| e.to_string()),
        None => Ok(HermesConfigMeta::default()),
    }
}
