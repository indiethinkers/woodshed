// Resource commands. Files at vault/resources/<id>.md, where id is slugged
// from the title on creation. Filename = id for direct path lookup, mirroring
// the People and Notebook patterns. Sorted by `saved` descending in the list
// view (newest captures first).

use crate::commands::{daily, people};
use crate::network::{self, PublicFetchOptions};
use crate::parsers::{self, Resource as ParsedResource};
use crate::sync_ext::MutexRecover;
use crate::vault as vault_lib;
use crate::wikilinks::{
    collect_rewrite_markdown_files, creation_trace_text, labels_match, push_unique_label,
    replace_wikilink_labels, safe_wikilink_label,
};
use crate::AppState;
use kuchikiki::traits::*;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const CAPTURE_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.0 Safari/605.1.15 Woodshed/0.1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDto {
    pub id: String,
    pub path: String, // vault-relative
    pub title: String,
    pub url: String,
    pub source: String,
    pub saved: String,
    /// Linked person ids (authors/creators). Empty when unset.
    pub people: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    pub tags: Vec<String>,
    pub highlights: Vec<String>,
    pub favorite: bool,
    pub body: String,
}

impl ResourceDto {
    pub(crate) fn from_parsed(b: ParsedResource, vault: &Path, abs_path: &Path) -> Self {
        let rel = abs_path
            .strip_prefix(vault)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| abs_path.to_string_lossy().to_string());
        let body = clean_legacy_capture_body(&b.body);
        ResourceDto {
            id: b.id,
            path: rel,
            title: b.title,
            url: b.url,
            source: b.source,
            saved: b.saved,
            people: b.people,
            published: b.published,
            captured_at: b.captured_at,
            content_hash: b.content_hash,
            tags: b.tags,
            highlights: b.highlights,
            favorite: b.favorite,
            body,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCreate {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub highlights: Vec<String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUpdate {
    pub title: Option<String>,
    pub url: Option<String>,
    pub source: Option<String>,
    /// Full replacement list of linked person ids.
    #[serde(default)]
    pub people: Option<Vec<String>>,
    pub published: Option<String>,
    pub captured_at: Option<String>,
    pub content_hash: Option<String>,
    pub tags: Option<Vec<String>>,
    pub highlights: Option<Vec<String>>,
    pub favorite: Option<bool>,
    pub body: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCaptureUrlInput {
    pub url: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub published: Option<String>,
    #[serde(default)]
    pub highlights: Vec<String>,
    /// Editor-paste captures set this: the embed already lives in the body
    /// the user is editing, so the daily-page trace would be a duplicate —
    /// and on the daily page itself the append would race the journal
    /// editor's autosave.
    #[serde(default)]
    pub skip_daily_log: bool,
    /// Re-fetch metadata for an existing resource. This is only set by the
    /// explicit refresh control on an embed card; normal captures stay
    /// deduplicated and never create background network traffic.
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone)]
struct ExtractedArticle {
    title: Option<String>,
    canonical_url: Option<String>,
    source: Option<String>,
    author: Option<String>,
    published: Option<String>,
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let path = store
        .get("vault_path")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "vault not configured".to_string())?;
    Ok(PathBuf::from(path))
}

fn resource_path(vault: &Path, id: &str) -> Result<PathBuf, String> {
    vault_lib::record_file_path(vault, vault_lib::RESOURCES_DIR, id)
}

/// Slugify a title into a filesystem-safe id. Lowercases, collapses
/// non-alphanumeric runs into single dashes, trims edges.
fn slugify_title(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_dash = true;
    for c in title.chars() {
        if c.is_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    if out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "resource".to_string()
    } else {
        out
    }
}

fn unique_id(vault: &Path, base: &str) -> Result<String, String> {
    if !resource_path(vault, base)?.exists() {
        return Ok(base.to_string());
    }
    for n in 2..1000 {
        let candidate = format!("{}-{}", base, n);
        if !resource_path(vault, &candidate)?.exists() {
            return Ok(candidate);
        }
    }
    Ok(format!(
        "{}-{}",
        base,
        chrono::Utc::now().timestamp_millis()
    ))
}

/// Best-effort host extractor for the source field. `https://www.foo.com/bar`
/// becomes `foo.com`. Falls back to the input string when parsing fails.
fn host_from_url(url: &str) -> String {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let host = after_scheme.split('/').next().unwrap_or(after_scheme);
    let host = host.split('?').next().unwrap_or(host);
    let host = host.trim_start_matches("www.");
    if host.is_empty() {
        url.to_string()
    } else {
        host.to_string()
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn validate_http_url(url: &str) -> Result<reqwest::Url, String> {
    network::validate_public_http_url(url, false)
}

/// Public oEmbed endpoint for hosts whose pages don't yield metadata to a
/// plain HTML fetch — x.com serves a JS shell with no server-rendered meta
/// tags — or where oEmbed is simply more dependable than scraping (YouTube
/// consent interstitials). None for every other host.
fn oembed_endpoint_for(url: &reqwest::Url) -> Option<reqwest::Url> {
    let host = url.host_str()?.trim_start_matches("www.");
    let endpoint = match host {
        "x.com" | "twitter.com" | "mobile.twitter.com" => "https://publish.twitter.com/oembed",
        "youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtu.be" => {
            "https://www.youtube.com/oembed"
        }
        _ => return None,
    };
    let mut endpoint = reqwest::Url::parse(endpoint).ok()?;
    endpoint
        .query_pairs_mut()
        .append_pair("url", url.as_str())
        .append_pair("format", "json")
        .append_pair("omit_script", "true");
    Some(endpoint)
}

/// Resolve title / author / published via oEmbed — no AI, just the
/// provider's own metadata. YouTube answers with the real video title; X
/// has no title field, so one is assembled from the author name plus the
/// tweet text embedded in the `html` payload. X deliberately shortens
/// long-form posts there, so an incomplete response gets one bounded lookup
/// through FxTwitter's public status API for the complete text.
/// None (unknown host, network failure, unusable payload) falls back to
/// the generic HTML scrape.
async fn fetch_oembed_article(url: &reqwest::Url) -> Option<ExtractedArticle> {
    let endpoint = oembed_endpoint_for(url)?;
    let response = network::fetch_public(
        endpoint.as_str(),
        &PublicFetchOptions {
            max_bytes: 1024 * 1024,
            max_redirects: 3,
            timeout: FETCH_TIMEOUT,
            user_agent: CAPTURE_USER_AGENT,
            accept: Some("application/json"),
            https_only: true,
        },
    )
    .await
    .ok()?;
    let payload: JsonValue = serde_json::from_slice(&response.bytes).ok()?;
    let article = oembed_article(&payload, url)?;
    if article
        .title
        .as_deref()
        .is_some_and(tweet_text_is_incomplete)
    {
        return fetch_fxtwitter_article(url).await.or(Some(article));
    }
    Some(article)
}

async fn fetch_fxtwitter_article(url: &reqwest::Url) -> Option<ExtractedArticle> {
    let endpoint = fxtwitter_endpoint_for(url)?;
    let response = network::fetch_public(
        endpoint.as_str(),
        &PublicFetchOptions {
            max_bytes: 1024 * 1024,
            max_redirects: 2,
            timeout: FETCH_TIMEOUT,
            user_agent: CAPTURE_USER_AGENT,
            accept: Some("application/json"),
            https_only: true,
        },
    )
    .await
    .ok()?;
    let payload: JsonValue = serde_json::from_slice(&response.bytes).ok()?;
    fxtwitter_article(&payload, url)
}

fn fxtwitter_endpoint_for(url: &reqwest::Url) -> Option<reqwest::Url> {
    let host = url.host_str()?.trim_start_matches("www.");
    if !matches!(host, "x.com" | "twitter.com" | "mobile.twitter.com") {
        return None;
    }
    let segments = url.path_segments()?.collect::<Vec<_>>();
    let status_index = segments.iter().position(|segment| *segment == "status")?;
    let id = segments.get(status_index + 1)?;
    if id.is_empty() || id.len() > 40 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    reqwest::Url::parse(&format!("https://api.fxtwitter.com/status/{id}")).ok()
}

fn fxtwitter_article(payload: &JsonValue, url: &reqwest::Url) -> Option<ExtractedArticle> {
    let tweet = payload.get("tweet").or_else(|| payload.get("status"))?;
    let text = normalize_tweet_text(&json_str(tweet, "text")?);
    if text.is_empty() || tweet_text_is_incomplete(&text) {
        return None;
    }
    let author = tweet
        .get("author")
        .and_then(|value| json_str(value, "name"));
    let published = json_str(tweet, "created_at").and_then(|raw| {
        chrono::DateTime::parse_from_str(&raw, "%a %b %e %H:%M:%S %z %Y")
            .or_else(|_| chrono::DateTime::parse_from_rfc2822(&raw))
            .or_else(|_| chrono::DateTime::parse_from_rfc3339(&raw))
            .ok()
            .map(|date| date.format("%Y-%m-%d").to_string())
    });
    let title = format!("{} on X: {text}", author.as_deref().unwrap_or("Post"));

    Some(ExtractedArticle {
        title: Some(title),
        canonical_url: Some(url.to_string()),
        source: Some("x.com".to_string()),
        author,
        published,
    })
}

fn oembed_article(payload: &JsonValue, url: &reqwest::Url) -> Option<ExtractedArticle> {
    let host = url.host_str().unwrap_or("").trim_start_matches("www.");
    let author = json_str(payload, "author_name");
    let is_tweet = matches!(host, "x.com" | "twitter.com" | "mobile.twitter.com");

    let (title, source, published) = if is_tweet {
        let (text, published) = tweet_text_and_date(payload)?;
        let title = format!("{} on X: {}", author.as_deref().unwrap_or("Post"), text,);
        (title, "x.com".to_string(), published)
    } else {
        (json_str(payload, "title")?, "youtube.com".to_string(), None)
    };

    Some(ExtractedArticle {
        title: Some(title),
        canonical_url: None,
        source: Some(source),
        author,
        published,
    })
}

/// Tweet text + date out of the oEmbed `html` blockquote:
/// `<blockquote><p>text…</p>&mdash; Author (@handle) <a …>March 5, 2026</a></blockquote>`
fn tweet_text_and_date(payload: &JsonValue) -> Option<(String, Option<String>)> {
    let html = json_str(payload, "html")?;
    let document = kuchikiki::parse_html().one(html.as_str()).document_node;
    let text = document.select_first("blockquote p").ok()?.text_contents();
    let text = normalize_tweet_text(&text);
    if text.is_empty() {
        return None;
    }
    let published = document
        .select("blockquote > a")
        .ok()
        .and_then(|mut anchors| anchors.next_back())
        .map(|anchor| anchor.text_contents())
        .and_then(|raw| chrono::NaiveDate::parse_from_str(raw.trim(), "%B %e, %Y").ok())
        .map(|date| date.format("%Y-%m-%d").to_string());
    Some((text, published))
}

fn normalize_tweet_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn tweet_text_is_incomplete(text: &str) -> bool {
    let text = text.trim_end();
    text.ends_with('…') || text.ends_with("...")
}

fn json_str(payload: &JsonValue, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn article_fallback_for_url(url: &reqwest::Url) -> ExtractedArticle {
    ExtractedArticle {
        title: title_from_url(url),
        canonical_url: Some(url.to_string()),
        source: url
            .host_str()
            .map(|host| host.trim_start_matches("www.").to_string()),
        author: None,
        published: published_from_url_path(url),
    }
}

fn title_from_url(url: &reqwest::Url) -> Option<String> {
    let slug = url
        .path_segments()?
        .rev()
        .find(|segment| !segment.trim().is_empty())?;
    let slug = slug
        .trim_end_matches(".html")
        .trim_end_matches(".htm")
        .trim_end_matches(".md")
        .trim_end_matches(".php")
        .replace("%20", " ")
        .replace("%2F", " ");
    let words = slug
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(title_case_word)
        .collect::<Vec<_>>();
    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}

fn title_case_word(word: &str) -> String {
    match word.to_ascii_lowercase().as_str() {
        "ai" | "a.i" => "AI".to_string(),
        "api" => "API".to_string(),
        "ceo" => "CEO".to_string(),
        "cto" => "CTO".to_string(),
        "llm" => "LLM".to_string(),
        "nytimes" => "NYTimes".to_string(),
        "us" | "u.s" => "US".to_string(),
        lower => {
            let mut chars = lower.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        }
    }
}

fn published_from_url_path(url: &reqwest::Url) -> Option<String> {
    let segments = url
        .path_segments()?
        .filter(|segment| !segment.trim().is_empty())
        .collect::<Vec<_>>();
    for window in segments.windows(3) {
        let Ok(year) = window[0].parse::<i32>() else {
            continue;
        };
        let Ok(month) = window[1].parse::<u32>() else {
            continue;
        };
        let Ok(day) = window[2].parse::<u32>() else {
            continue;
        };
        if let Some(date) = chrono::NaiveDate::from_ymd_opt(year, month, day) {
            return Some(date.format("%Y-%m-%d").to_string());
        }
    }
    None
}

/// The 11-char YouTube video id for a URL, when it is a YouTube video
/// link. Covers `watch?v=` (with arbitrary params before `v=`), `/embed/`,
/// `/shorts/`, `/live/`, and `youtu.be` short links across the www/m/music/
/// youtube-nocookie hosts. Query params (`list`, `t`, `si`) are ignored —
/// the video id is the resource's identity, not the URL spelling.
fn youtube_video_id(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed
        .host_str()?
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let id = match host.as_str() {
        "youtu.be" => parsed
            .path()
            .trim_start_matches('/')
            .split('/')
            .next()?
            .to_string(),
        "youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtube-nocookie.com" => {
            let path = parsed.path();
            if path.starts_with("/watch") {
                parsed
                    .query_pairs()
                    .find(|(key, _)| key == "v")
                    .map(|(_, value)| value.to_string())?
            } else {
                // /embed/<id>, /shorts/<id>, /live/<id>
                path.trim_start_matches('/').split('/').nth(1)?.to_string()
            }
        }
        _ => return None,
    };
    let id = id.trim();
    (id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    .then(|| id.to_string())
}

/// Canonical URL for a resource. YouTube videos map to the canonical watch
/// URL (`https://www.youtube.com/watch?v=<id>`) so every spelling of the
/// same video dedupes to one record; everything else is unchanged.
fn canonical_resource_url(url: &str) -> String {
    match youtube_video_id(url) {
        Some(id) => format!("https://www.youtube.com/watch?v={id}"),
        None => url.to_string(),
    }
}

fn url_key(url: &str) -> String {
    let canonical = canonical_resource_url(url);
    match reqwest::Url::parse(&canonical) {
        Ok(mut parsed) => {
            parsed.set_fragment(None);
            let s = parsed.to_string();
            s.trim_end_matches('/').to_ascii_lowercase()
        }
        Err(_) => canonical.trim().trim_end_matches('/').to_ascii_lowercase(),
    }
}

fn find_resource_by(
    vault: &Path,
    mut predicate: impl FnMut(&ParsedResource) -> bool,
) -> Result<Option<(ParsedResource, PathBuf)>, String> {
    let dir = vault_lib::resources_dir(vault);
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
        let content = match vault_lib::read_record(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let parsed = match parsers::parse_resource(&content) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if predicate(&parsed) {
            return Ok(Some((parsed, path)));
        }
    }
    Ok(None)
}

fn find_resource_by_url(
    vault: &Path,
    url: &str,
) -> Result<Option<(ParsedResource, PathBuf)>, String> {
    let needle_url = url_key(url);
    find_resource_by(vault, |resource| url_key(&resource.url) == needle_url)
}

fn select_attr(document: &kuchikiki::NodeRef, selector: &str, attr: &str) -> Option<String> {
    let node = document.select(selector).ok()?.next()?;
    let attrs = node.attributes.borrow();
    attrs
        .get(attr)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn select_text(document: &kuchikiki::NodeRef, selector: &str) -> Option<String> {
    document
        .select(selector)
        .ok()?
        .next()
        .map(|node| normalize_inline_text(&node.as_node().text_contents()))
        .filter(|s| !s.is_empty())
}

fn select_meta_content(document: &kuchikiki::NodeRef, keys: &[&str]) -> Option<String> {
    for key in keys {
        let escaped = key.replace('"', "\\\"");
        let selectors = [
            format!("meta[property=\"{escaped}\"]"),
            format!("meta[name=\"{escaped}\"]"),
        ];
        for selector in selectors {
            if let Some(value) = select_attr(document, &selector, "content") {
                return Some(value);
            }
        }
    }
    None
}

#[derive(Debug, Default)]
struct JsonLdArticleMetadata {
    title: Option<String>,
    author: Option<String>,
    published: Option<String>,
}

fn json_string(value: &JsonValue) -> Option<String> {
    value
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn json_field_string(object: &serde_json::Map<String, JsonValue>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = object.get(*key).and_then(json_string) {
            return Some(value);
        }
    }
    None
}

fn json_author(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(_) => json_string(value),
        JsonValue::Object(object) => json_field_string(object, &["name"]),
        JsonValue::Array(items) => {
            let names = items.iter().filter_map(json_author).collect::<Vec<_>>();
            if names.is_empty() {
                None
            } else {
                Some(names.join(", "))
            }
        }
        _ => None,
    }
}

fn json_type_includes_article(value: Option<&JsonValue>) -> bool {
    match value {
        Some(JsonValue::String(type_)) => {
            let type_ = type_.to_ascii_lowercase();
            type_.contains("article") || type_.contains("posting") || type_.contains("news")
        }
        Some(JsonValue::Array(types)) => types
            .iter()
            .any(|type_| json_type_includes_article(Some(type_))),
        _ => false,
    }
}

fn merge_json_ld_article(value: &JsonValue, out: &mut JsonLdArticleMetadata) {
    match value {
        JsonValue::Array(items) => {
            for item in items {
                merge_json_ld_article(item, out);
            }
        }
        JsonValue::Object(object) => {
            if let Some(graph) = object.get("@graph") {
                merge_json_ld_article(graph, out);
            }

            let article_like = json_type_includes_article(object.get("@type"))
                || object.contains_key("headline")
                || object.contains_key("datePublished");
            if article_like {
                if out.title.is_none() {
                    out.title = json_field_string(object, &["headline", "name"]);
                }
                if out.published.is_none() {
                    out.published = json_field_string(
                        object,
                        &["datePublished", "dateCreated", "dateModified"],
                    )
                    .map(normalize_date);
                }
                if out.author.is_none() {
                    out.author = object.get("author").and_then(json_author);
                }
            }

            for value in object.values() {
                if out.title.is_some() && out.author.is_some() && out.published.is_some() {
                    break;
                }
                if value.is_object() || value.is_array() {
                    merge_json_ld_article(value, out);
                }
            }
        }
        _ => {}
    }
}

fn extract_json_ld_article(document: &kuchikiki::NodeRef) -> JsonLdArticleMetadata {
    let mut out = JsonLdArticleMetadata::default();
    let Ok(nodes) = document.select("script[type=\"application/ld+json\"]") else {
        return out;
    };
    for node in nodes {
        let text = node.as_node().text_contents();
        let Ok(value) = serde_json::from_str::<JsonValue>(&text) else {
            continue;
        };
        merge_json_ld_article(&value, &mut out);
    }
    out
}

fn canonical_url(document: &kuchikiki::NodeRef, fetched_url: &reqwest::Url) -> Option<String> {
    let href = select_attr(document, "link[rel=\"canonical\"]", "href")?;
    fetched_url
        .join(&href)
        .map(|url| url.to_string())
        .or_else(|_| reqwest::Url::parse(&href).map(|url| url.to_string()))
        .ok()
}

fn normalize_inline_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_date(value: String) -> String {
    value
        .split_whitespace()
        .next()
        .unwrap_or(value.as_str())
        .trim_matches(',')
        .to_string()
}

fn is_capture_blocker_title(title: &str) -> bool {
    let lower = title.trim().to_ascii_lowercase();
    lower.is_empty()
        || matches!(
            lower.as_str(),
            "access denied"
                | "forbidden"
                | "403 forbidden"
                | "attention required"
                | "just a moment..."
                | "just a moment"
        )
        || lower.contains("enable javascript")
        || lower.contains("are you a robot")
        || lower.contains("request blocked")
}

fn merge_url_fallbacks(article: &mut ExtractedArticle, url: &reqwest::Url) {
    article.title = article
        .title
        .take()
        .filter(|title| !is_capture_blocker_title(title))
        .or_else(|| title_from_url(url));
    if article
        .source
        .as_ref()
        .map(|source| source.trim().is_empty())
        .unwrap_or(true)
    {
        article.source = url
            .host_str()
            .map(|host| host.trim_start_matches("www.").to_string());
    }
    if article.published.is_none() {
        article.published = published_from_url_path(url);
    }
    if article.canonical_url.is_none() {
        article.canonical_url = Some(url.to_string());
    }
}

fn extract_article(html: &str, fetched_url: &reqwest::Url) -> ExtractedArticle {
    let document = kuchikiki::parse_html().one(html).document_node;
    let json_ld = extract_json_ld_article(&document);
    if let Ok(nodes) = document.select(
        "script, style, noscript, svg, iframe, nav, footer, header, aside, form, button, input",
    ) {
        for node in nodes.collect::<Vec<_>>() {
            node.as_node().detach();
        }
    }

    let canonical_url = canonical_url(&document, fetched_url);
    let title = select_meta_content(&document, &["og:title", "twitter:title"])
        .or(json_ld.title)
        .or_else(|| select_text(&document, "title"))
        .or_else(|| select_text(&document, "h1"));
    let source =
        select_meta_content(&document, &["og:site_name", "application-name"]).or_else(|| {
            fetched_url
                .host_str()
                .map(|host| host.trim_start_matches("www.").to_string())
        });
    let author = select_meta_content(&document, &["author", "article:author", "parsely-author"])
        .or(json_ld.author);
    let published = select_meta_content(
        &document,
        &[
            "article:published_time",
            "date",
            "datePublished",
            "pubdate",
            "publish-date",
        ],
    )
    .map(normalize_date)
    .or(json_ld.published);

    ExtractedArticle {
        title,
        canonical_url,
        source,
        author,
        published,
    }
}

fn clean_legacy_capture_body(body: &str) -> String {
    const MARKER: &str = "## Source Snapshot";
    let trimmed = body.trim();
    let starts_like_legacy = trimmed.starts_with("## Summary")
        || trimmed.starts_with("![Source image](")
        || trimmed.starts_with(MARKER);
    if !starts_like_legacy {
        return body.to_string();
    }

    let Some(marker_start) = trimmed.find(MARKER) else {
        return body.to_string();
    };
    let before = trimmed[..marker_start].trim();
    let marker_end = marker_start + MARKER.len();
    let article = trimmed[marker_end..].trim();
    if article.is_empty() {
        return body.to_string();
    }

    let mut sections = Vec::new();
    for block in before.split("\n\n") {
        let block = block.trim();
        if block.starts_with("![Source image](") {
            sections.push(block.to_string());
        }
    }
    sections.push(article.to_string());
    sections.join("\n\n")
}

fn write_resource(
    state: &State<AppState>,
    abs_path: &Path,
    resource: &ParsedResource,
) -> Result<(), String> {
    let serialized = parsers::serialize_resource(resource).map_err(|e| e.to_string())?;
    if let Some(watcher) = state.watcher.lock_recover().as_ref() {
        watcher.record_self_write(abs_path);
    }
    vault_lib::write_atomic(abs_path, &serialized).map_err(|e| e.to_string())
}

fn index_resource(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    abs_path: &Path,
    resource: &ParsedResource,
) {
    if let Ok(idx) = state.ensure_index(app) {
        let rel = crate::index::rel_path_str(vault, abs_path);
        if let Err(e) = idx.upsert(&crate::index::doc_from_resource(resource, &rel)) {
            eprintln!("index resource {}: {}", resource.id, e);
        }
    }
}

fn append_resource_link_to_today(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    resource: &ParsedResource,
) -> Result<(), String> {
    let trace_text = creation_trace_text(&wikilink_label_for_resource(resource));
    daily::log_line_on_today(
        app,
        state,
        vault,
        &trace_text,
        &[&resource.id, &resource.title],
    )
}

#[cfg(test)]
fn append_resource_link_to_daily_body(
    body: &str,
    resource: &ParsedResource,
    timestamp: &str,
) -> String {
    let trace_text = creation_trace_text(&wikilink_label_for_resource(resource));
    daily::append_log_line(
        body,
        timestamp,
        &trace_text,
        &[&resource.id, &resource.title],
    )
}

fn wikilink_label_for_resource(resource: &ParsedResource) -> String {
    safe_wikilink_label(&resource.title, &resource.id)
}

fn rewrite_resource_backlinks_after_title_change(
    app: &AppHandle,
    state: &State<AppState>,
    vault: &Path,
    resource: &ParsedResource,
    old_title: &str,
) -> Result<usize, String> {
    let new_label = wikilink_label_for_resource(resource);
    let mut old_labels = Vec::new();
    push_unique_label(&mut old_labels, old_title);
    push_unique_label(&mut old_labels, &resource.id);
    old_labels.retain(|label| !labels_match(label, &new_label));
    if old_labels.is_empty() {
        return Ok(0);
    }

    let files = collect_rewrite_markdown_files(vault)?;

    let mut changed = 0usize;
    for path in files {
        let raw = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
        let Some(next) = replace_wikilink_labels(&raw, &old_labels, &new_label) else {
            continue;
        };
        if let Some(watcher) = state.watcher.lock().unwrap().as_ref() {
            watcher.record_self_write(&path);
        }
        vault_lib::write_atomic(&path, &next).map_err(|e| e.to_string())?;
        if let Ok(idx) = state.ensure_index(app) {
            if let Err(e) = idx.refresh_path(vault, &path) {
                eprintln!("refresh backlinks {}: {}", path.display(), e);
            }
        }
        changed += 1;
    }
    Ok(changed)
}

fn unindex_resource(app: &AppHandle, state: &State<AppState>, id: &str) {
    if let Ok(idx) = state.ensure_index(app) {
        let rel = format!("resources/{}.md", id);
        if let Err(e) = idx.delete_by_path(&rel) {
            eprintln!("unindex resource {}: {}", id, e);
        }
    }
}

pub(crate) fn read_resource(vault: &Path, abs_path: &Path) -> Result<ResourceDto, String> {
    let content = vault_lib::read_record(abs_path).map_err(|e| e.to_string())?;
    let parsed = parsers::parse_resource(&content).map_err(|e| format!("{:#}", e))?;
    Ok(ResourceDto::from_parsed(parsed, vault, abs_path))
}

#[tauri::command]
pub fn resource_create(
    app: AppHandle,
    state: State<AppState>,
    input: ResourceCreate,
) -> Result<ResourceDto, String> {
    let vault = vault_root(&app)?;
    std::fs::create_dir_all(vault.join(vault_lib::RESOURCES_DIR)).map_err(|e| e.to_string())?;

    // Manual creation must not duplicate an existing canonical URL. The
    // key collapses URL spellings (YouTube video ids, fragments, case,
    // trailing slashes), so re-saving a video in any form returns the
    // saved resource instead of minting a -2 / -3 sibling. Mirrors the
    // capture path's dedupe.
    if let Some((existing, path)) = find_resource_by_url(&vault, &input.url)? {
        return Ok(ResourceDto::from_parsed(existing, &vault, &path));
    }

    let id = unique_id(&vault, &slugify_title(&input.title))?;
    let path = resource_path(&vault, &id)?;

    let source = input
        .source
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| host_from_url(&input.url));

    let resource = ParsedResource {
        id: id.clone(),
        title: input.title,
        url: input.url,
        source,
        area: None,
        saved: chrono::Local::now().to_rfc3339(),
        people: Vec::new(),
        published: None,
        captured_at: None,
        content_hash: None,
        agent_status: BTreeMap::new(),
        tags: input.tags,
        highlights: input.highlights,
        favorite: false,
        body: input.body.unwrap_or_default(),
    };

    write_resource(&state, &path, &resource)?;
    index_resource(&app, &state, &vault, &path, &resource);
    append_resource_link_to_today(&app, &state, &vault, &resource)?;
    Ok(ResourceDto::from_parsed(resource, &vault, &path))
}

/// Capture a URL as a resource. Fetches the page only to read metadata
/// (title, source, author, published) — the article body is intentionally
/// NOT scraped; the resource body stays the user's own notes. The captured
/// author becomes a linked person: an existing match is reused, an unknown
/// byline is created as a minimal person record. Re-capturing a URL already
/// in the vault returns the saved resource unless the caller explicitly asks
/// to refresh its provider metadata.
#[tauri::command]
pub async fn resource_capture_url(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ResourceCaptureUrlInput,
) -> Result<ResourceDto, String> {
    let vault = vault_root(&app)?;
    std::fs::create_dir_all(vault.join(vault_lib::RESOURCES_DIR)).map_err(|e| e.to_string())?;

    let requested_url = validate_http_url(&input.url)?;
    let requested_url_string = requested_url.to_string();
    let existing = find_resource_by_url(&vault, &requested_url_string)?;
    if let Some((resource, path)) = &existing {
        if !input.refresh {
            return Ok(ResourceDto::from_parsed(resource.clone(), &vault, path));
        }
    }

    let now = chrono::Local::now().to_rfc3339();
    let (mut article, final_url) = if let Some(oembed) = fetch_oembed_article(&requested_url).await
    {
        (oembed, requested_url.clone())
    } else {
        let fetched = network::fetch_public(
            requested_url.as_str(),
            &PublicFetchOptions {
                max_bytes: 5 * 1024 * 1024,
                max_redirects: 8,
                timeout: FETCH_TIMEOUT,
                user_agent: CAPTURE_USER_AGENT,
                accept: Some("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
                https_only: false,
            },
        )
        .await;

        match fetched {
            Ok(response) => {
                let final_url = response.final_url;
                let html = String::from_utf8_lossy(&response.bytes);
                match html.trim().is_empty() {
                    false => (extract_article(&html, &final_url), final_url),
                    true => (article_fallback_for_url(&final_url), final_url),
                }
            }
            Err(_) => (
                article_fallback_for_url(&requested_url),
                requested_url.clone(),
            ),
        }
    };

    merge_url_fallbacks(&mut article, &final_url);

    // Re-check for an existing record now that the metadata fetch is done.
    // The pre-fetch lookup above can miss a record whose capture is still
    // in flight (concurrent pastes of the same video), which would
    // otherwise mint -2 / -3 siblings; the canonical key makes any
    // spelling of the same URL land on the same record.
    if let Some((resource, path)) = find_resource_by_url(&vault, &requested_url_string)? {
        if !input.refresh {
            return Ok(ResourceDto::from_parsed(resource, &vault, &path));
        }
    }

    let canonical = article
        .canonical_url
        .clone()
        .unwrap_or_else(|| final_url.to_string());
    // Store the canonical spelling (YouTube videos collapse to the watch
    // URL) so the record's url matches the dedupe identity in url_key —
    // re-capturing any spelling of the same video finds this record.
    let canonical = canonical_resource_url(&canonical);
    let source = clean_optional(input.source.clone())
        .or(article.source.clone())
        .unwrap_or_else(|| host_from_url(&canonical));
    let title = clean_optional(input.title.clone())
        .or(article.title.clone())
        .unwrap_or_else(|| source.clone());
    let author_byline = clean_optional(input.author.clone()).or(article.author.clone());
    let author = people::resolve_or_create_author(&app, &state, &vault, author_byline.as_deref())?;
    let published = clean_optional(input.published.clone()).or(article.published.clone());

    if let Some((mut resource, path)) = existing {
        resource.title = title;
        resource.url = canonical;
        resource.source = source;
        // A fresh byline replaces the linked people; an absent byline
        // preserves whatever the user had already attached.
        if let Some(person_id) = author {
            resource.people = vec![person_id];
        }
        resource.published = published;
        resource.captured_at = Some(now);
        write_resource(&state, &path, &resource)?;
        index_resource(&app, &state, &vault, &path, &resource);
        return Ok(ResourceDto::from_parsed(resource, &vault, &path));
    }

    // Tweets and videos *are* their embed — seed the body with the media URL
    // on its own line so the editor's URL-paragraph transform renders the
    // post / video inline on the detail page (and the title is derived from
    // it via oEmbed). Articles keep an empty body — the user's own notes; we
    // never scrape article text into it.
    let body = if oembed_endpoint_for(&final_url).is_some() {
        format!("{canonical}\n")
    } else {
        String::new()
    };

    let id = unique_id(&vault, &slugify_title(&title))?;
    let path = resource_path(&vault, &id)?;
    let resource = ParsedResource {
        id,
        title,
        url: canonical,
        source,
        area: None,
        saved: now.clone(),
        people: author.into_iter().collect(),
        published,
        captured_at: Some(now),
        content_hash: None,
        agent_status: BTreeMap::new(),
        tags: input.tags,
        highlights: input.highlights,
        favorite: false,
        body,
    };

    write_resource(&state, &path, &resource)?;
    index_resource(&app, &state, &vault, &path, &resource);
    if !input.skip_daily_log {
        append_resource_link_to_today(&app, &state, &vault, &resource)?;
    }
    Ok(ResourceDto::from_parsed(resource, &vault, &path))
}

#[tauri::command]
pub fn resource_get(app: AppHandle, id: String) -> Result<Option<ResourceDto>, String> {
    let vault = vault_root(&app)?;
    let path = resource_path(&vault, &id)?;
    if !path.exists() {
        return Ok(None);
    }
    read_resource(&vault, &path).map(Some)
}

#[tauri::command]
pub fn resource_update(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    update: ResourceUpdate,
) -> Result<ResourceDto, String> {
    let vault = vault_root(&app)?;
    let path = resource_path(&vault, &id)?;
    let content = vault_lib::read_record(&path).map_err(|e| e.to_string())?;
    let mut resource = parsers::parse_resource(&content).map_err(|e| format!("{:#}", e))?;
    let old_title = resource.title.clone();
    let mut title_changed = false;

    if let Some(t) = update.title {
        title_changed = !labels_match(&resource.title, &t);
        resource.title = t;
    }
    if let Some(u) = update.url {
        resource.url = u;
    }
    if let Some(s) = update.source {
        resource.source = s;
    }
    // Resources do not belong to an area. Cleared here as well as in
    // `serialize_resource` so an in-memory update can never reintroduce a value
    // that the next write would silently drop.
    resource.area = None;
    if let Some(people) = update.people {
        // The picker commits the full replacement list; defensive trim
        // keeps stray empties out of the vault file.
        resource.people = people
            .into_iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
    }
    if let Some(published) = update.published {
        resource.published = if published.trim().is_empty() {
            None
        } else {
            Some(published)
        };
    }
    if let Some(captured_at) = update.captured_at {
        resource.captured_at = if captured_at.trim().is_empty() {
            None
        } else {
            Some(captured_at)
        };
    }
    if let Some(content_hash) = update.content_hash {
        resource.content_hash = if content_hash.trim().is_empty() {
            None
        } else {
            Some(content_hash)
        };
    }
    if let Some(t) = update.tags {
        resource.tags = t;
    }
    if let Some(h) = update.highlights {
        resource.highlights = h;
    }
    if let Some(f) = update.favorite {
        resource.favorite = f;
    }
    if let Some(b) = update.body {
        resource.body = b;
    }

    write_resource(&state, &path, &resource)?;
    index_resource(&app, &state, &vault, &path, &resource);
    if title_changed {
        rewrite_resource_backlinks_after_title_change(&app, &state, &vault, &resource, &old_title)?;
        return read_resource(&vault, &path);
    }
    Ok(ResourceDto::from_parsed(resource, &vault, &path))
}

#[tauri::command]
pub fn resource_delete(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let vault = vault_root(&app)?;
    let path = resource_path(&vault, &id)?;
    // Capture the labels its creation trace was logged under *before* the file
    // is gone, so we can scrub that auto-added backlink from the day's journal.
    let labels = backlink_labels_for_resource(&vault, &path, &id);
    if let Some(watcher) = state.watcher.lock().unwrap().as_ref() {
        watcher.record_self_write(&path);
    }
    if path.exists() {
        vault_lib::move_to_trash(&vault, &path)?;
    }
    unindex_resource(&app, &state, &id);
    if let Err(e) = crate::wikilinks::remove_record_backlinks(&app, &state, &vault, &labels) {
        eprintln!("scrub backlinks for resource {}: {}", id, e);
    }
    Ok(())
}

/// The wikilink labels a resource's auto-added creation trace could appear
/// under: its current title (read best-effort before deletion) and its id.
fn backlink_labels_for_resource(vault: &Path, path: &Path, id: &str) -> Vec<String> {
    let mut labels = vec![id.to_string()];
    if let Ok(resource) = read_resource(vault, path) {
        push_unique_label(
            &mut labels,
            &safe_wikilink_label(&resource.title, &resource.id),
        );
    }
    labels
}

#[tauri::command]
pub async fn resources_all(app: AppHandle) -> Result<Vec<ResourceDto>, String> {
    let vault = vault_root(&app)?;
    read_all_resources(&vault)
}

pub(crate) fn read_all_resources(vault: &Path) -> Result<Vec<ResourceDto>, String> {
    let dir = vault_lib::resources_dir(vault);
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
        match read_resource(vault, &path) {
            Ok(b) => out.push(b),
            Err(e) => eprintln!("skipping {}: {}", path.display(), e),
        }
    }
    // Newest first — date-grouping in the list bucket by saved day.
    out.sort_by(|a, b| b.saved.cmp(&a.saved));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VAULT_SUBDIRS;
    use tempfile::TempDir;

    fn setup_vault() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        for sub in VAULT_SUBDIRS {
            std::fs::create_dir_all(vault.join(sub)).unwrap();
        }
        (tmp, vault)
    }

    fn write_sample(vault: &Path, id: &str, title: &str, saved: &str) -> PathBuf {
        let resource = ParsedResource {
            id: id.to_string(),
            title: title.to_string(),
            url: format!("https://example.com/{}", id),
            source: "example.com".to_string(),
            area: None,
            saved: saved.to_string(),
            people: Vec::new(),
            published: None,
            captured_at: None,
            content_hash: None,
            agent_status: BTreeMap::new(),
            tags: vec![],
            highlights: vec![],
            favorite: false,
            body: String::new(),
        };
        let path = resource_path(vault, id).unwrap();
        let serialized = parsers::serialize_resource(&resource).unwrap();
        std::fs::write(&path, serialized).unwrap();
        path
    }

    #[test]
    fn oembed_endpoint_only_for_twitter_and_youtube_hosts() {
        let tweet = reqwest::Url::parse("https://x.com/karpathy/status/123456").unwrap();
        let endpoint = oembed_endpoint_for(&tweet).unwrap();
        assert_eq!(endpoint.host_str(), Some("publish.twitter.com"));
        assert!(endpoint.query().unwrap().contains("karpathy"));

        let video = reqwest::Url::parse("https://youtu.be/dQw4w9WgXcQ").unwrap();
        let endpoint = oembed_endpoint_for(&video).unwrap();
        assert_eq!(endpoint.host_str(), Some("www.youtube.com"));

        let article = reqwest::Url::parse("https://example.com/post").unwrap();
        assert!(oembed_endpoint_for(&article).is_none());
    }

    #[test]
    fn fxtwitter_endpoint_accepts_only_numeric_x_status_ids() {
        let tweet = reqwest::Url::parse("https://x.com/alexrivera/status/123456?s=20").unwrap();
        assert_eq!(
            fxtwitter_endpoint_for(&tweet).unwrap().as_str(),
            "https://api.fxtwitter.com/status/123456"
        );

        let article = reqwest::Url::parse("https://example.com/status/123456").unwrap();
        assert!(fxtwitter_endpoint_for(&article).is_none());

        let malformed = reqwest::Url::parse("https://x.com/alexrivera/status/not-an-id").unwrap();
        assert!(fxtwitter_endpoint_for(&malformed).is_none());
    }

    #[test]
    fn oembed_article_builds_tweet_title_from_html_payload() {
        let payload = serde_json::json!({
            "author_name": "Alex Rivera",
            "html": "<blockquote class=\"twitter-tweet\"><p lang=\"en\">Local-first software is the future of personal tools.</p>&mdash; Alex Rivera (@alexrivera) <a href=\"https://twitter.com/alexrivera/status/123\">March 5, 2026</a></blockquote>",
        });
        let url = reqwest::Url::parse("https://x.com/alexrivera/status/123").unwrap();
        let article = oembed_article(&payload, &url).unwrap();
        assert_eq!(
            article.title.as_deref(),
            Some("Alex Rivera on X: Local-first software is the future of personal tools.")
        );
        assert_eq!(article.source.as_deref(), Some("x.com"));
        assert_eq!(article.author.as_deref(), Some("Alex Rivera"));
        assert_eq!(article.published.as_deref(), Some("2026-03-05"));
    }

    #[test]
    fn oembed_article_keeps_complete_tweet_text() {
        let text = "word ".repeat(40);
        let payload = serde_json::json!({
            "author_name": "Alex Rivera",
            "html": format!("<blockquote><p>{}</p></blockquote>", text),
        });
        let url = reqwest::Url::parse("https://x.com/alexrivera/status/123").unwrap();
        let article = oembed_article(&payload, &url).unwrap();
        let title = article.title.unwrap();
        assert_eq!(title, format!("Alex Rivera on X: {}", text.trim()));
        assert!(!title.ends_with('…'));
    }

    #[test]
    fn fxtwitter_article_uses_complete_longform_text() {
        let text = "A complete synthetic long-form post with its real final sentence.";
        let payload = serde_json::json!({
            "tweet": {
                "text": text,
                "created_at": "Fri Jul 31 19:12:00 +0000 2026",
                "author": { "name": "Alex Rivera" }
            }
        });
        let url = reqwest::Url::parse("https://x.com/alexrivera/status/123456").unwrap();

        let article = fxtwitter_article(&payload, &url).unwrap();

        assert_eq!(
            article.title.as_deref(),
            Some("Alex Rivera on X: A complete synthetic long-form post with its real final sentence.")
        );
        assert_eq!(article.source.as_deref(), Some("x.com"));
        assert_eq!(article.author.as_deref(), Some("Alex Rivera"));
        assert_eq!(article.published.as_deref(), Some("2026-07-31"));
    }

    #[test]
    fn only_incomplete_tweet_text_uses_the_longform_fallback() {
        assert!(tweet_text_is_incomplete("A provider teaser…"));
        assert!(tweet_text_is_incomplete("A provider teaser..."));
        assert!(!tweet_text_is_incomplete("A complete post."));
    }

    #[test]
    fn oembed_article_uses_youtube_title_verbatim() {
        let payload = serde_json::json!({
            "title": "Simple Made Easy",
            "author_name": "Rich Hickey",
        });
        let url = reqwest::Url::parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ").unwrap();
        let article = oembed_article(&payload, &url).unwrap();
        assert_eq!(article.title.as_deref(), Some("Simple Made Easy"));
        assert_eq!(article.source.as_deref(), Some("youtube.com"));
        assert_eq!(article.author.as_deref(), Some("Rich Hickey"));
    }

    #[test]
    fn oembed_article_without_usable_payload_falls_through() {
        let url = reqwest::Url::parse("https://x.com/alexrivera/status/123").unwrap();
        assert!(oembed_article(&serde_json::json!({}), &url).is_none());
    }

    fn sample_resource_for_link(id: &str, title: &str) -> ParsedResource {
        ParsedResource {
            id: id.to_string(),
            title: title.to_string(),
            url: format!("https://example.com/{}", id),
            source: "example.com".to_string(),
            area: None,
            saved: "2026-05-21T21:03:00-07:00".to_string(),
            people: Vec::new(),
            published: None,
            captured_at: None,
            content_hash: None,
            agent_status: BTreeMap::new(),
            tags: Vec::new(),
            highlights: Vec::new(),
            favorite: false,
            body: String::new(),
        }
    }

    #[test]
    fn resource_daily_link_appends_timestamped_wikilink() {
        let resource = sample_resource_for_link("deep-work", "Deep Work in the age of AI");
        let body = "- [11:25] Existing note";

        assert_eq!(
            append_resource_link_to_daily_body(body, &resource, "21:03"),
            "- [11:25] Existing note\n- [21:03] [[Deep Work in the age of AI]]"
        );
    }

    #[test]
    fn resource_daily_link_replaces_empty_placeholder_body() {
        let resource = sample_resource_for_link("deep-work", "Deep Work in the age of AI");

        assert_eq!(
            append_resource_link_to_daily_body("- ", &resource, "21:03"),
            "- [21:03] [[Deep Work in the age of AI]]"
        );
    }

    #[test]
    fn resource_daily_link_does_not_duplicate_existing_link() {
        let resource = sample_resource_for_link("deep-work", "Deep Work in the age of AI");
        let body = "- [21:03] [[Deep Work in the age of AI]]";

        assert_eq!(
            append_resource_link_to_daily_body(body, &resource, "21:04"),
            body
        );
    }

    #[test]
    fn resource_daily_link_falls_back_to_id_for_unsafe_title() {
        let resource = sample_resource_for_link("deep-work", "Deep [Work]");

        assert_eq!(
            append_resource_link_to_daily_body("", &resource, "21:03"),
            "- [21:03] [[deep-work]]"
        );
    }

    #[test]
    fn resource_backlink_rewrite_updates_title_and_id_links() {
        let old_labels = vec![
            "Deep Work in the age of AI".to_string(),
            "deep-work".to_string(),
        ];
        let raw = "- [[Deep Work in the age of AI]]\n- [[deep-work]]\n- [[Unrelated Resource]]";

        assert_eq!(
            replace_wikilink_labels(raw, &old_labels, "Deep Work and AI").as_deref(),
            Some("- [[Deep Work and AI]]\n- [[Deep Work and AI]]\n- [[Unrelated Resource]]")
        );
    }

    #[test]
    fn resource_backlink_rewrite_is_case_insensitive() {
        let old_labels = vec!["Deep Work in the age of AI".to_string()];
        let raw = "- [[deep work in the age of ai]]";

        assert_eq!(
            replace_wikilink_labels(raw, &old_labels, "Deep Work and AI").as_deref(),
            Some("- [[Deep Work and AI]]")
        );
    }

    #[test]
    fn resource_backlink_rewrite_ignores_plain_text_mentions() {
        let old_labels = vec!["Deep Work in the age of AI".to_string()];
        let raw = "Deep Work in the age of AI\n\n[[Other]]";

        assert_eq!(
            replace_wikilink_labels(raw, &old_labels, "Deep Work and AI"),
            None
        );
    }

    #[test]
    fn slugify_title_collapses_punctuation() {
        assert_eq!(
            slugify_title("Local-first software: You own your data"),
            "local-first-software-you-own-your-data"
        );
        assert_eq!(slugify_title("File over app"), "file-over-app");
    }

    #[test]
    fn slugify_empty_falls_back() {
        assert_eq!(slugify_title(""), "resource");
        assert_eq!(slugify_title("###"), "resource");
    }

    #[test]
    fn unique_id_appends_2_3_on_collision() {
        let (_tmp, vault) = setup_vault();
        write_sample(&vault, "thoughts", "Thoughts", "2026-04-25T10:00:00-04:00");
        assert_eq!(unique_id(&vault, "thoughts").unwrap(), "thoughts-2");
        write_sample(
            &vault,
            "thoughts-2",
            "Thoughts again",
            "2026-04-25T10:00:00-04:00",
        );
        assert_eq!(unique_id(&vault, "thoughts").unwrap(), "thoughts-3");
    }

    #[test]
    fn host_from_url_strips_scheme_and_www() {
        assert_eq!(
            host_from_url("https://www.inkandswitch.com/local-first/"),
            "inkandswitch.com"
        );
        assert_eq!(
            host_from_url("http://stephango.com/file-over-app"),
            "stephango.com"
        );
        assert_eq!(host_from_url("foo.com/bar"), "foo.com");
        assert_eq!(host_from_url(""), "");
    }

    #[test]
    fn youtube_video_id_extracts_id_from_every_url_shape() {
        for url in [
            "https://www.youtube.com/watch?v=bd5ABsobEqU",
            "https://www.youtube.com/watch?v=bd5ABsobEqU&list=WL&index=2",
            "https://www.youtube.com/watch?app=desktop&v=bd5ABsobEqU&t=60s",
            "http://youtube.com/watch?v=bd5ABsobEqU",
            "https://m.youtube.com/watch?v=bd5ABsobEqU",
            "https://music.youtube.com/watch?v=bd5ABsobEqU",
            "https://youtu.be/bd5ABsobEqU",
            "https://youtu.be/bd5ABsobEqU?si=abc123",
            "https://www.youtube.com/shorts/bd5ABsobEqU",
            "https://www.youtube.com/embed/bd5ABsobEqU",
            "https://www.youtube.com/live/bd5ABsobEqU",
            "https://www.youtube-nocookie.com/embed/bd5ABsobEqU",
        ] {
            assert_eq!(
                youtube_video_id(url).as_deref(),
                Some("bd5ABsobEqU"),
                "url: {url}"
            );
        }
    }

    #[test]
    fn youtube_video_id_rejects_non_youtube_and_bad_ids() {
        assert_eq!(
            youtube_video_id("https://example.com/watch?v=bd5ABsobEqU"),
            None
        );
        assert_eq!(
            youtube_video_id("https://www.nytimes.com/2026/04/30/opinion/x.html"),
            None
        );
        assert_eq!(
            youtube_video_id("https://www.youtube.com/watch?v=short"),
            None
        );
        assert_eq!(
            youtube_video_id("https://www.youtube.com/playlist?list=WL"),
            None
        );
        assert_eq!(youtube_video_id("not a url"), None);
    }

    #[test]
    fn url_key_collapses_every_spelling_of_the_same_video() {
        let variants = [
            "https://www.youtube.com/watch?v=bd5ABsobEqU",
            "https://www.youtube.com/watch?v=bd5ABsobEqU&list=WL&index=2",
            "http://youtube.com/watch?v=bd5ABsobEqU",
            "https://youtu.be/bd5ABsobEqU",
        ];
        let key = url_key(variants[0]);
        for variant in variants {
            assert_eq!(url_key(variant), key, "variant: {variant}");
        }
        assert_eq!(
            key, "https://www.youtube.com/watch?v=bd5absobequ",
            "canonical watch URL, lowercased"
        );
        // Distinct videos and non-youtube URLs keep distinct keys.
        assert_ne!(
            url_key(variants[0]),
            url_key("https://www.youtube.com/watch?v=HQXi4snP36I")
        );
        assert_ne!(
            url_key(variants[0]),
            url_key("https://www.nytimes.com/2026/04/30/opinion/silicon-valley-ai.html")
        );
    }

    #[test]
    fn find_resource_by_url_matches_every_spelling_of_the_same_video() {
        let tmp = tempfile::TempDir::new().unwrap();
        let vault = tmp.path();
        std::fs::create_dir_all(vault.join("resources")).unwrap();
        // A saved resource whose URL is the canonical watch link.
        let resource = crate::parsers::Resource {
            id: "economy-video".to_string(),
            title: "What A.I. Is Actually Doing to the Economy".to_string(),
            url: "https://www.youtube.com/watch?v=bd5ABsobEqU".to_string(),
            source: "youtube.com".to_string(),
            area: None,
            saved: "2026-08-06T19:34:05.242350-07:00".to_string(),
            people: vec![],
            published: None,
            captured_at: None,
            content_hash: None,
            agent_status: Default::default(),
            tags: vec![],
            highlights: vec![],
            favorite: false,
            body: String::new(),
        };
        std::fs::write(
            vault.join("resources").join("economy-video.md"),
            crate::parsers::serialize_resource(&resource).unwrap(),
        )
        .unwrap();

        // Any spelling of the same video resolves to the saved record —
        // the regression that produced -2 / -3 duplicates.
        let variants = [
            "https://www.youtube.com/watch?v=bd5ABsobEqU",
            "https://www.youtube.com/watch?v=bd5ABsobEqU&list=WL&index=2",
            "http://youtube.com/watch?v=bd5ABsobEqU",
            "https://youtu.be/bd5ABsobEqU",
        ];
        for variant in variants {
            let found = find_resource_by_url(vault, variant).unwrap();
            assert!(
                found.is_some(),
                "spelling not deduped to the saved record: {variant}"
            );
        }
        // A different video stays distinct.
        assert!(
            find_resource_by_url(vault, "https://www.youtube.com/watch?v=HQXi4snP36I")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn url_fallback_extracts_article_slug_and_date() {
        let url = reqwest::Url::parse(
            "https://www.nytimes.com/2026/04/30/opinion/silicon-valley-ai-underclass.html",
        )
        .unwrap();
        assert_eq!(
            title_from_url(&url).as_deref(),
            Some("Silicon Valley AI Underclass")
        );
        assert_eq!(published_from_url_path(&url).as_deref(), Some("2026-04-30"));
    }

    #[test]
    fn extract_article_reads_metadata() {
        let url = reqwest::Url::parse("https://example.com/post").unwrap();
        let html = r#"
            <html>
              <head>
                <title>Fallback title</title>
                <link rel="canonical" href="/canonical-post" />
                <meta property="og:title" content="Captured title" />
                <meta property="og:site_name" content="Example" />
                <meta name="author" content="Jasmine Sun" />
                <meta property="article:published_time" content="2026-05-13T09:00:00-07:00" />
              </head>
              <body>
                <nav>Ignore this</nav>
                <article>
                  <h1>Captured title</h1>
                  <p>First paragraph.</p>
                </article>
              </body>
            </html>
        "#;

        let article = extract_article(html, &url);
        assert_eq!(article.title.as_deref(), Some("Captured title"));
        assert_eq!(
            article.canonical_url.as_deref(),
            Some("https://example.com/canonical-post")
        );
        assert_eq!(article.source.as_deref(), Some("Example"));
        assert_eq!(article.author.as_deref(), Some("Jasmine Sun"));
        assert_eq!(
            article.published.as_deref(),
            Some("2026-05-13T09:00:00-07:00")
        );
    }

    #[test]
    fn extract_article_reads_json_ld_metadata() {
        let url = reqwest::Url::parse("https://example.com/post").unwrap();
        let html = r#"
            <html>
              <head>
                <script type="application/ld+json">
                {
                  "@type": "NewsArticle",
                  "headline": "JSON-LD title",
                  "author": { "name": "Jasmine Sun" },
                  "datePublished": "2026-04-30T08:00:00-04:00",
                  "description": "JSON-LD summary",
                  "image": { "url": "https://example.com/jsonld.jpg" }
                }
                </script>
              </head>
              <body>
                <article>
                  <p>One paragraph keeps the document non-empty.</p>
                </article>
              </body>
            </html>
        "#;

        let article = extract_article(html, &url);
        assert_eq!(article.title.as_deref(), Some("JSON-LD title"));
        assert_eq!(article.author.as_deref(), Some("Jasmine Sun"));
        assert_eq!(
            article.published.as_deref(),
            Some("2026-04-30T08:00:00-04:00")
        );
    }

    #[test]
    fn clean_legacy_capture_body_removes_generated_wrappers() {
        let body = "\
## Summary

A useful article summary.

![Source image](https://example.com/cover.jpg)

## Source Snapshot

# Captured title

First paragraph.";

        assert_eq!(
            clean_legacy_capture_body(body),
            "\
![Source image](https://example.com/cover.jpg)

# Captured title

First paragraph."
        );
    }

    #[test]
    fn clean_legacy_capture_body_keeps_normal_user_markdown() {
        let body = "Notes before a section.\n\n## Source Snapshot\n\nA user-authored section.";
        assert_eq!(clean_legacy_capture_body(body), body);
    }

    #[test]
    fn read_all_resources_sorts_newest_first() {
        let (_tmp, vault) = setup_vault();
        write_sample(&vault, "old", "Old", "2026-01-01T10:00:00-04:00");
        write_sample(&vault, "new", "New", "2026-04-25T10:00:00-04:00");
        write_sample(&vault, "mid", "Mid", "2026-03-15T10:00:00-04:00");

        let resources = read_all_resources(&vault).unwrap();
        let ids: Vec<_> = resources.iter().map(|b| b.id.clone()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    #[test]
    fn read_all_resources_skips_non_md_files() {
        let (_tmp, vault) = setup_vault();
        write_sample(&vault, "x", "X", "2026-04-25T10:00:00-04:00");
        std::fs::write(
            vault_lib::resources_dir(&vault).join("not-a-resource.txt"),
            "noise",
        )
        .unwrap();
        assert_eq!(read_all_resources(&vault).unwrap().len(), 1);
    }

    #[test]
    fn read_all_resources_skips_corrupt_files() {
        let (_tmp, vault) = setup_vault();
        write_sample(&vault, "x", "X", "2026-04-25T10:00:00-04:00");
        std::fs::write(
            vault_lib::resources_dir(&vault).join("corrupt.md"),
            "this is not valid frontmatter",
        )
        .unwrap();
        assert_eq!(read_all_resources(&vault).unwrap().len(), 1);
    }

    #[test]
    fn read_all_resources_returns_empty_when_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        assert!(read_all_resources(&vault).unwrap().is_empty());
    }
}
