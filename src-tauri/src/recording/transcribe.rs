// Cloud speech helpers for the agent's voice features.
//
//   - Deepgram (single-channel) → flat transcript for dictation / voice mode.
//   - Deepgram Aura → text-to-speech for voice mode's spoken replies.
//
// Both calls go directly from the desktop binary over HTTPS (reqwest) with a
// user-supplied key — see `recording::keys`. No Woodshed server in the loop.

use serde_json::{json, Value};
use std::time::Duration;

// Single-channel (mic-only) listen for agent dictation / voice mode — no
// multichannel/utterances, just the flat transcript of one speaker.
const DEEPGRAM_MONO_URL: &str =
    "https://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&smart_format=true";
// Aura text-to-speech. `aura-asteria-en` is a stable, natural English voice;
// the default container is MP3, which the WebView plays back directly.
const DEEPGRAM_SPEAK_URL: &str = "https://api.deepgram.com/v1/speak";
const DEEPGRAM_JSON_LIMIT: usize = 1024 * 1024;
const DEEPGRAM_AUDIO_LIMIT: usize = 25 * 1024 * 1024;
const DEEPGRAM_ERROR_LIMIT: usize = 64 * 1024;

/// Transcribe a single-speaker audio clip (mic capture from the agent
/// composer / voice mode) into one flat string. `content_type` is the MIME of
/// the uploaded bytes (e.g. `audio/webm`), which the WebView's MediaRecorder
/// determines. Returns an empty string for silence rather than erroring — a
/// dictation tap that caught nothing should quietly no-op.
pub async fn deepgram_transcribe_mono(
    audio: Vec<u8>,
    key: &str,
    content_type: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("build Deepgram client failed: {e}"))?;
    let resp = client
        .post(DEEPGRAM_MONO_URL)
        .header("Authorization", format!("Token {key}"))
        .header("Content-Type", content_type.to_string())
        .body(audio)
        .send()
        .await
        .map_err(|e| format!("deepgram request failed: {e}"))?;

    let status = resp.status();
    let max_bytes = if status.is_success() {
        DEEPGRAM_JSON_LIMIT
    } else {
        DEEPGRAM_ERROR_LIMIT
    };
    let body = crate::network::read_response_limited(resp, max_bytes)
        .await
        .map_err(|e| format!("deepgram read failed: {e}"))?;
    let body = String::from_utf8_lossy(&body);
    if !status.is_success() {
        return Err(format!("deepgram error {status}: {body}"));
    }
    let json: Value = serde_json::from_str(&body).map_err(|e| format!("deepgram json: {e}"))?;
    let text = json["results"]["channels"][0]["alternatives"][0]["transcript"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(text)
}

/// Synthesize speech for `text` via Deepgram Aura. Returns MP3 bytes. `voice`
/// is an Aura model id (e.g. `aura-asteria-en`); falls back to Asteria.
pub async fn deepgram_speak(text: &str, key: &str, voice: &str) -> Result<Vec<u8>, String> {
    let model = if voice.trim().is_empty() {
        "aura-asteria-en"
    } else {
        voice.trim()
    };
    if model.len() > 64
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid Deepgram voice id".to_string());
    }
    let mut url = reqwest::Url::parse(DEEPGRAM_SPEAK_URL)
        .map_err(|e| format!("invalid Deepgram endpoint: {e}"))?;
    url.query_pairs_mut().append_pair("model", model);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("build Deepgram client failed: {e}"))?;
    let resp = client
        .post(url)
        .header("Authorization", format!("Token {key}"))
        .header("Content-Type", "application/json")
        .json(&json!({ "text": text }))
        .send()
        .await
        .map_err(|e| format!("deepgram speak request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = crate::network::read_response_limited(resp, DEEPGRAM_ERROR_LIMIT)
            .await
            .unwrap_or_default();
        let body = String::from_utf8_lossy(&body);
        return Err(format!("deepgram speak error {status}: {body}"));
    }
    let bytes = crate::network::read_response_limited(resp, DEEPGRAM_AUDIO_LIMIT)
        .await
        .map_err(|e| format!("deepgram speak read failed: {e}"))?;
    Ok(bytes)
}
