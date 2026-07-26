// Disk-backed image cache for email rendering.
//
// Email bodies routinely embed 30+ remote `<img>` tags. The default
// behavior — letting WKWebView fetch each one over HTTPS at iframe-paint
// time — gates the entire perceived render on the slowest CDN response.
// This module sits in front of those fetches:
//
//   `<img src="https://cdn.example/x.png">`  →
//   `<img src="wsmail://localhost/img/<b64-of-original-url>">`
//
// The `wsmail://` URI scheme handler resolves the cache key, serves the
// bytes from `<app_data_dir>/image-cache/<sha256>` if present, otherwise
// fetches the upstream URL once, persists it, and serves the bytes. A
// sibling `<sha256>.txt` file under `image-cache-meta/` carries the
// Content-Type so we can serve the correct MIME on cache hits without
// re-introspecting the bytes.
//
// Fetches are constrained by the shared public-network policy (no local
// addresses, bounded redirects/body size), and the disk cache has a hard
// quota with oldest-entry eviction.

use crate::network::{self, PublicFetchOptions};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};
use tokio::fs;
use tokio::io::AsyncWriteExt;

const CACHE_DIR_NAME: &str = "image-cache";
const META_DIR_NAME: &str = "image-cache-meta";
// Bump this string any time the rendered wrapper template changes in
// a way that should invalidate cached entries; old directories become
// dead leaves that can be cleaned out separately.
//   v2 — drop `content-visibility: auto` from wrapper styles
//   v3 — emit `width`/`height` attrs on `<img>` from cached dims
const RENDER_CACHE_DIR_NAME: &str = "email-render-cache-v3";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const FALLBACK_CONTENT_TYPE: &str = "application/octet-stream";
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 32_768;
const MAX_IMAGE_PIXELS: u64 = 100_000_000;
const MAX_PREFETCH_URLS: usize = 32;
const MAX_PARALLEL_FETCHES: usize = 6;
const CACHE_QUOTA_BYTES: u64 = 256 * 1024 * 1024;
const MAX_RENDERED_BODY_BYTES: usize = 16 * 1024 * 1024;

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    Ok(base.join(CACHE_DIR_NAME))
}

fn meta_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    Ok(base.join(META_DIR_NAME))
}

fn url_to_key(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    hex_lower(hasher.finalize().as_slice())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(*b >> 4) as usize] as char);
        out.push(HEX[(*b & 0xf) as usize] as char);
    }
    out
}

/// Decode the path component of a `wsmail://localhost/img/<b64>` URL
/// back into the original upstream URL. Returns the original URL string.
pub fn decode_image_path(uri: &str) -> Result<String, String> {
    if uri.len() > 16 * 1024 {
        return Err("image URI exceeds 16 KiB".to_string());
    }
    let after_scheme = uri
        .split_once("://")
        .map(|(_, rest)| rest)
        .ok_or_else(|| format!("malformed uri: {uri}"))?;
    let path = after_scheme
        .split_once('/')
        .map(|(_, path)| path)
        .ok_or_else(|| format!("missing path: {uri}"))?;
    let encoded = path
        .strip_prefix("img/")
        .ok_or_else(|| format!("expected /img/ prefix: {uri}"))?
        .trim_end_matches('/');
    // Strip query string and any trailing fragment if present (some
    // browsers append cache-busters automatically when revalidating).
    let encoded = encoded.split(['?', '#']).next().unwrap_or(encoded);
    if encoded.len() > 12 * 1024 {
        return Err("encoded image URL is too long".to_string());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|e| format!("base64 decode: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("utf-8: {e}"))
}

/// Meta file format:
///   line 1: content-type
///   line 2 (optional): "WIDTHxHEIGHT" for the image's intrinsic
///                       dimensions, captured at fetch time so the
///                       email renderer can emit `width`/`height`
///                       attrs and the browser reserves space upfront.
fn format_meta(content_type: &str, dimensions: Option<(u32, u32)>) -> String {
    match dimensions {
        Some((w, h)) => format!("{content_type}\n{w}x{h}"),
        None => content_type.to_string(),
    }
}

fn parse_meta(text: &str) -> (String, Option<(u32, u32)>) {
    let mut lines = text.lines();
    let content_type = lines
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| FALLBACK_CONTENT_TYPE.to_string());
    let dims = lines.next().and_then(parse_dims);
    (content_type, dims)
}

fn parse_dims(s: &str) -> Option<(u32, u32)> {
    let s = s.trim();
    let (w_str, h_str) = s.split_once('x')?;
    let w: u32 = w_str.parse().ok()?;
    let h: u32 = h_str.parse().ok()?;
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

fn decode_image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    imagesize::blob_size(bytes)
        .ok()
        .map(|sz| (sz.width as u32, sz.height as u32))
}

fn validate_image_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    let (width, height) = decode_image_dimensions(bytes)
        .ok_or_else(|| "remote response had invalid image dimensions".to_string())?;
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_PIXELS
    {
        return Err("remote image dimensions exceed safety limits".to_string());
    }
    Ok((width, height))
}

/// Read a previously-cached entry. Returns `Ok(None)` if not present;
/// `Err` is reserved for IO errors that aren't ENOENT.
async fn read_cached(app: &AppHandle, key: &str) -> Result<Option<(Vec<u8>, String)>, String> {
    let path = cache_dir(app)?.join(key);
    let bytes = match fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read cache {}: {e}", path.display())),
    };
    if detected_image_type(&bytes).is_none() || validate_image_dimensions(&bytes).is_err() {
        let _ = fs::remove_file(&path).await;
        if let Ok(meta) = meta_dir(app) {
            let _ = fs::remove_file(meta.join(format!("{key}.txt"))).await;
        }
        return Ok(None);
    }
    let meta_path = meta_dir(app)?.join(format!("{key}.txt"));
    let content_type = match fs::read_to_string(&meta_path).await {
        Ok(s) => parse_meta(&s).0,
        Err(_) => FALLBACK_CONTENT_TYPE.to_string(),
    };
    Ok(Some((bytes, content_type)))
}

/// Look up an image's intrinsic pixel dimensions by upstream URL. The
/// renderer calls this before emitting the rewritten `<img>` so that
/// it can attach `width`/`height` attrs — the browser then reserves
/// the correct box and email layout doesn't shift as the image lands.
///
/// Returns `None` when the image isn't in the cache yet. Lazy-migrates
/// pre-existing entries that lack a dimensions line in their meta
/// file: decodes the cached bytes once and rewrites the meta so the
/// next lookup is a single read.
pub async fn lookup_dimensions(app: &AppHandle, url: &str) -> Option<(u32, u32)> {
    let key = url_to_key(url);
    let meta_path = meta_dir(app).ok()?.join(format!("{key}.txt"));
    let meta_text = match fs::read_to_string(&meta_path).await {
        Ok(s) => s,
        Err(_) => return None,
    };
    let (content_type, dims) = parse_meta(&meta_text);
    if dims.is_some() {
        return dims;
    }
    // Lazy migration — meta exists but predates dimensions capture.
    let bytes_path = cache_dir(app).ok()?.join(&key);
    let bytes = fs::read(&bytes_path).await.ok()?;
    let dims = validate_image_dimensions(&bytes).ok()?;
    let rewritten = format_meta(&content_type, Some(dims));
    let _ = fs::write(&meta_path, rewritten.as_bytes()).await;
    Some(dims)
}

async fn write_cache_atomic(
    app: &AppHandle,
    key: &str,
    bytes: &[u8],
    content_type: &str,
    dimensions: Option<(u32, u32)>,
) -> Result<(), String> {
    let cache = cache_dir(app)?;
    let meta = meta_dir(app)?;
    fs::create_dir_all(&cache)
        .await
        .map_err(|e| format!("mkdir cache: {e}"))?;
    fs::create_dir_all(&meta)
        .await
        .map_err(|e| format!("mkdir meta: {e}"))?;

    // Write to a temp file in the same dir, then rename — guarantees
    // readers either see the fully-written entry or no entry at all,
    // even if the app is killed mid-fetch.
    let final_path = cache.join(key);
    let tmp_path = cache.join(format!("{key}.tmp"));
    let mut f = fs::File::create(&tmp_path)
        .await
        .map_err(|e| format!("create tmp: {e}"))?;
    f.write_all(bytes)
        .await
        .map_err(|e| format!("write tmp: {e}"))?;
    f.flush().await.map_err(|e| format!("flush tmp: {e}"))?;
    drop(f);
    fs::rename(&tmp_path, &final_path)
        .await
        .map_err(|e| format!("rename tmp: {e}"))?;
    fs::write(
        meta.join(format!("{key}.txt")),
        format_meta(content_type, dimensions).as_bytes(),
    )
    .await
    .map_err(|e| format!("write meta: {e}"))?;
    enforce_cache_quota(app).await;
    Ok(())
}

async fn fetch_upstream(url: &str) -> Result<(Vec<u8>, String, Option<(u32, u32)>), String> {
    let response = network::fetch_public(
        url,
        &PublicFetchOptions {
            max_bytes: MAX_IMAGE_BYTES,
            max_redirects: 5,
            timeout: REQUEST_TIMEOUT,
            user_agent: "Woodshed/0.1 image-cache",
            accept: Some("image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9"),
            https_only: false,
        },
    )
    .await?;
    let bytes = response.bytes;
    let content_type = detected_image_type(&bytes)
        .ok_or_else(|| "remote response was not a supported raster image".to_string())?
        .to_string();
    let dimensions = validate_image_dimensions(&bytes)?;
    Ok((bytes, content_type, Some(dimensions)))
}

fn detected_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if brand == b"avif" || brand == b"avis" {
            return Some("image/avif");
        }
        None
    } else {
        None
    }
}

async fn enforce_cache_quota(app: &AppHandle) {
    let Ok(dir) = cache_dir(app) else { return };
    let Ok(mut reader) = fs::read_dir(&dir).await else {
        return;
    };
    let mut total = 0u64;
    let mut entries = Vec::new();
    while let Ok(Some(entry)) = reader.next_entry().await {
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        if !metadata.is_file() || entry.file_name().to_string_lossy().ends_with(".tmp") {
            continue;
        }
        total = total.saturating_add(metadata.len());
        entries.push((
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            metadata.len(),
            entry.path(),
            entry.file_name().to_string_lossy().into_owned(),
        ));
    }
    if total <= CACHE_QUOTA_BYTES {
        return;
    }
    entries.sort_by_key(|(modified, _, _, _)| *modified);
    for (_, size, path, key) in entries {
        if total <= CACHE_QUOTA_BYTES {
            break;
        }
        if fs::remove_file(&path).await.is_ok() {
            total = total.saturating_sub(size);
            if let Ok(meta) = meta_dir(app) {
                let _ = fs::remove_file(meta.join(format!("{key}.txt"))).await;
            }
        }
    }
}

/// Get the bytes + content-type for `url`, hitting the disk cache first
/// and fetching upstream on miss. Writes the cache entry on a successful
/// fetch. Subsequent calls for the same URL serve from disk.
pub async fn get_or_fetch(app: &AppHandle, url: &str) -> Result<(Vec<u8>, String), String> {
    let key = url_to_key(url);
    if let Some(hit) = read_cached(app, &key).await? {
        return Ok(hit);
    }
    let (bytes, content_type, dimensions) = fetch_upstream(url).await?;
    if let Err(e) = write_cache_atomic(app, &key, &bytes, &content_type, dimensions).await {
        // Cache write failures shouldn't fail the request — the user
        // gets the image, the next open re-fetches.
        let safe_url = reqwest::Url::parse(url)
            .map(|parsed| network::url_for_log(&parsed))
            .unwrap_or_else(|_| "<invalid-url>".to_string());
        eprintln!("image-cache: failed to persist {safe_url}: {e}");
    }
    Ok((bytes, content_type))
}

/// Warm the bounded image cache after the user explicitly chooses to load a
/// message's remote images. This is internal backend work, not an IPC command.
pub async fn prefetch_all(app: &AppHandle, urls: Vec<String>) {
    use tokio::task::JoinSet;
    let mut unique = HashSet::new();
    let urls: Vec<String> = urls
        .into_iter()
        .filter(|url| unique.insert(url.clone()))
        .take(MAX_PREFETCH_URLS)
        .collect();
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_PARALLEL_FETCHES));
    let mut set: JoinSet<()> = JoinSet::new();
    for url in urls {
        let app = app.clone();
        let semaphore = semaphore.clone();
        set.spawn(async move {
            let Ok(_permit) = semaphore.acquire_owned().await else {
                return;
            };
            if let Err(error) = get_or_fetch(&app, &url).await {
                let safe_url = reqwest::Url::parse(&url)
                    .map(|parsed| network::url_for_log(&parsed))
                    .unwrap_or_else(|_| "<invalid-url>".to_string());
                eprintln!("image-cache load: {safe_url}: {error}");
            }
        });
    }
    while set.join_next().await.is_some() {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendered-email-body cache (wsmail:// `/body/<message-id>` path)
//
// Sibling to the image cache; same on-disk layout idea but keyed by
// sha256(message_id) instead of sha256(url). The render itself happens
// in `crate::email_render` — this module just persists and serves the
// bytes. First open of a given email pays the render+vault-lookup
// cost; every subsequent open is a single disk read.
// ─────────────────────────────────────────────────────────────────────────────

fn render_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    Ok(base.join(RENDER_CACHE_DIR_NAME))
}

/// Hash the message id into a fixed-length, FS-safe filename. Match
/// the same shape `url_to_key` uses so the on-disk layouts feel
/// uniform.
fn id_to_render_key(id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(id.as_bytes());
    hex_lower(hasher.finalize().as_slice())
}

/// Read the cached rendered body for `message_id`. Ok(None) on cache
/// miss, Err only on IO errors that aren't ENOENT.
pub async fn read_rendered_body(
    app: &AppHandle,
    message_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    let path = render_cache_dir(app)?.join(format!("{}.html", id_to_render_key(message_id)));
    match fs::metadata(&path).await {
        Ok(metadata) if metadata.len() > MAX_RENDERED_BODY_BYTES as u64 => {
            return Err("rendered email body exceeds 16 MiB".to_string());
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("inspect render cache {}: {e}", path.display())),
    }
    match fs::read(&path).await {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read render cache {}: {e}", path.display())),
    }
}

/// Persist a rendered body atomically (temp + rename).
pub async fn write_rendered_body(
    app: &AppHandle,
    message_id: &str,
    rendered_html: &str,
) -> Result<(), String> {
    if rendered_html.len() > MAX_RENDERED_BODY_BYTES {
        return Err("rendered email body exceeds 16 MiB".to_string());
    }
    let dir = render_cache_dir(app)?;
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir render cache: {e}"))?;
    let key = id_to_render_key(message_id);
    let final_path = dir.join(format!("{}.html", key));
    let tmp_path = dir.join(format!("{}.html.tmp", key));
    let mut f = fs::File::create(&tmp_path)
        .await
        .map_err(|e| format!("create tmp: {e}"))?;
    f.write_all(rendered_html.as_bytes())
        .await
        .map_err(|e| format!("write tmp: {e}"))?;
    f.flush().await.map_err(|e| format!("flush tmp: {e}"))?;
    drop(f);
    fs::rename(&tmp_path, &final_path)
        .await
        .map_err(|e| format!("rename tmp: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_image_dimensions_are_bounded() {
        let normal = include_bytes!("../icons/32x32.png");
        assert_eq!(validate_image_dimensions(normal), Ok((32, 32)));

        let mut bomb = normal.to_vec();
        bomb[16..20].copy_from_slice(&100_000u32.to_be_bytes());
        bomb[20..24].copy_from_slice(&100_000u32.to_be_bytes());
        assert!(validate_image_dimensions(&bomb).is_err());
    }
}
