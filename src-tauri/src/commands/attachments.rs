// Attachment writes. Used by the Tiptap editor's paste/drop/picker paths
// to spill image bytes onto disk under `attachments/<ULID>.<ext>` and
// hand back the vault-relative path that goes into the markdown body
// as `![alt](attachments/<ULID>.<ext>)`.
//
// Without this, every pasted screenshot was getting inlined as a
// data:image/...;base64 URL — a 1 MiB PNG inflated tasks from a few
// hundred bytes to nearly a megabyte and made the editor sluggish.

use crate::sync_ext::MutexRecover;
use crate::AppState;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;
use ulid::Ulid;

const STORE_FILE: &str = "config.json";
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: usize = 32_768;
const MAX_IMAGE_PIXELS: usize = 100_000_000;

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

// Image-only allowlist. Pasting non-image binaries into a markdown editor
// is almost certainly accidental, so we reject everything else rather than
// letting users (or rogue clipboards) stash arbitrary files in the vault.
fn sanitize_image_ext(ext: &str) -> Option<&'static str> {
    let lower = ext.trim_start_matches('.').to_ascii_lowercase();
    match lower.as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        "heic" => Some("heic"),
        "avif" => Some("avif"),
        _ => None,
    }
}

pub(crate) fn validate_image_upload(bytes: &[u8], ext: &str) -> Result<&'static str, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "image must be between 1 and {MAX_IMAGE_BYTES} bytes"
        ));
    }
    let ext =
        sanitize_image_ext(ext).ok_or_else(|| format!("unsupported image extension: {ext}"))?;
    if !signature_matches_extension(bytes, ext) {
        return Err(format!("image bytes do not match .{ext}"));
    }
    let size =
        imagesize::blob_size(bytes).map_err(|_| "invalid or unsupported image".to_string())?;
    if size.width == 0
        || size.height == 0
        || size.width > MAX_IMAGE_DIMENSION
        || size.height > MAX_IMAGE_DIMENSION
        || size.width.saturating_mul(size.height) > MAX_IMAGE_PIXELS
    {
        return Err("image dimensions exceed safety limits".to_string());
    }
    Ok(ext)
}

fn signature_matches_extension(bytes: &[u8], ext: &str) -> bool {
    match ext {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" => bytes.starts_with(b"\xff\xd8\xff"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "avif" => iso_bmff_brand(bytes, &[b"avif", b"avis"]),
        "heic" => iso_bmff_brand(
            bytes,
            &[b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"],
        ),
        _ => false,
    }
}

fn iso_bmff_brand(bytes: &[u8], brands: &[&[u8; 4]]) -> bool {
    bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && brands.iter().any(|brand| bytes[8..12] == brand[..])
}

/// Write `bytes` to `<vault>/attachments/<ULID>.<ext>` and return the
/// vault-relative path (e.g. `attachments/01HM3Z....png`). Records a
/// self-write so the watcher doesn't bounce a redundant invalidation back
/// to the frontend.
#[tauri::command]
pub fn attachment_save(
    app: AppHandle,
    state: State<AppState>,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    let ext = validate_image_upload(&bytes, &ext)?;
    let vault = vault_root(&app)?;
    let id = Ulid::new().to_string();
    let filename = format!("{id}.{ext}");
    let rel = format!("attachments/{filename}");
    let parent = crate::vault::ensure_vault_directory(&vault, &["attachments"])?;
    let abs = crate::vault::confined_file_path(&vault, &parent, &filename)?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(&abs);
    }
    crate::vault::write_binary_atomic(&abs, &bytes)
        .map_err(|e| format!("write {}: {e:#}", abs.display()))?;
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_image_ext_normalizes_case_and_strips_dot() {
        assert_eq!(sanitize_image_ext(".PNG"), Some("png"));
        assert_eq!(sanitize_image_ext("Jpeg"), Some("jpg"));
        assert_eq!(sanitize_image_ext("webp"), Some("webp"));
    }

    #[test]
    fn sanitize_image_ext_rejects_non_image() {
        assert_eq!(sanitize_image_ext("exe"), None);
        assert_eq!(sanitize_image_ext("pdf"), None);
        assert_eq!(sanitize_image_ext("svg"), None);
        assert_eq!(sanitize_image_ext(""), None);
    }

    #[test]
    fn upload_validation_rejects_extension_spoofing_and_active_svg() {
        assert!(validate_image_upload(b"<svg><script>alert(1)</script></svg>", "svg").is_err());
        assert!(validate_image_upload(b"<html>not an image</html>", "png").is_err());
        assert!(validate_image_upload(b"GIF89a", "png").is_err());
    }

    #[test]
    fn upload_validation_accepts_a_small_valid_png() {
        let png = include_bytes!("../../icons/32x32.png");
        assert_eq!(validate_image_upload(png, "png"), Ok("png"));
    }
}
