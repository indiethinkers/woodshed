// Transcription Tauri commands for the agent's voice features.
//
// `voice_dictate` / `voice_speak` back the composer mic (dictation) and voice
// mode; the key-status commands drive the Settings → Accounts Deepgram field.
// Direct desktop → Deepgram, no Woodshed server. (The meeting-recording capture
// pipeline that also lived here was removed.)

use serde::Serialize;

use crate::recording::{keys, transcribe};

const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
const MAX_AUDIO_BASE64_BYTES: usize = (MAX_AUDIO_BYTES.div_ceil(3)) * 4;
const MAX_SPEECH_TEXT_BYTES: usize = 20 * 1024;

/// Whether the Deepgram key is configured (any path: env, .env.local, or
/// keychain). For the Settings status badge — never returns the secret.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionKeyStatus {
    pub deepgram: bool,
}

#[tauri::command]
pub fn transcription_keys_status() -> TranscriptionKeyStatus {
    TranscriptionKeyStatus {
        deepgram: keys::deepgram_configured(),
    }
}

/// Persist the Deepgram key to the OS keychain (release-flow Settings paste).
/// An empty value clears it.
#[tauri::command]
pub fn transcription_key_set(account: String, value: String) -> Result<(), String> {
    if account != "deepgram" {
        return Err(format!("unknown transcription key: {account}"));
    }
    keys::set_key(&account, &value)
}

/// Transcribe a mic clip captured in the agent composer (dictation) or voice
/// mode. `audio_base64` is the standard-base64 MediaRecorder blob; `mime` is
/// its MIME type (defaults to `audio/webm`). Returns the plain transcript
/// (empty string if the clip was silent). Direct desktop → Deepgram, no server.
#[tauri::command]
pub async fn voice_dictate(audio_base64: String, mime: Option<String>) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    if audio_base64.len() > MAX_AUDIO_BASE64_BYTES {
        return Err(format!("audio exceeds {MAX_AUDIO_BYTES} byte limit"));
    }
    let bytes = STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|e| format!("audio decode failed: {e}"))?;
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(format!("audio exceeds {MAX_AUDIO_BYTES} byte limit"));
    }
    if bytes.len() < 1024 {
        // Too small to contain speech — treat as a silent tap, not an error.
        return Ok(String::new());
    }
    let content_type = mime.unwrap_or_else(|| "audio/webm".to_string());
    validate_audio_mime(&content_type)?;
    let key = keys::deepgram_key()?;
    transcribe::deepgram_transcribe_mono(bytes, &key, &content_type).await
}

/// Synthesize speech for the agent's reply in voice mode (Deepgram Aura).
/// Returns standard-base64 MP3 the WebView plays back. `voice` is an optional
/// Aura model id.
#[tauri::command]
pub async fn voice_speak(text: String, voice: Option<String>) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("nothing to speak".into());
    }
    if trimmed.len() > MAX_SPEECH_TEXT_BYTES {
        return Err(format!(
            "speech text exceeds {MAX_SPEECH_TEXT_BYTES} byte limit"
        ));
    }
    let key = keys::deepgram_key()?;
    let audio = transcribe::deepgram_speak(trimmed, &key, voice.as_deref().unwrap_or("")).await?;
    Ok(STANDARD.encode(audio))
}

fn validate_audio_mime(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.len() > 100
        || !value.starts_with("audio/")
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b'\'' || byte == b'\"')
    {
        return Err("invalid audio MIME type".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_mime_validation_rejects_header_injection_and_non_audio() {
        assert!(validate_audio_mime("audio/webm;codecs=opus").is_ok());
        assert!(validate_audio_mime("text/plain").is_err());
        assert!(validate_audio_mime("audio/webm\r\nx-evil: yes").is_err());
    }
}
