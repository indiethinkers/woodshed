// Email body render pipeline.
//
// Takes the raw HTML the sender shipped (from the .html sibling next to
// each email's .md), runs a single streaming pass with `lol_html` to
//
//   - strip dangerous content (`<script>`, `<iframe>`, `<object>`,
//     `<embed>`, `<frame>`, `<frameset>`, `<base>`, `<head>`,
//     `<meta http-equiv="refresh|set-cookie">`, on* event-handler
//     attributes, `javascript:`/`data:` hrefs, `javascript:` srcs)
//   - unwrap any `<html>` / `<body>` tags so the email content sits
//     cleanly inside our own document wrapper
//   - decorate `<img>` for lazy network (`loading`, `decoding`,
//     `fetchpriority`) and route remote `src` through the wsmail://
//     image cache
//
// then wraps the result in a small HTML document that ships our
// styles and an inline bridge script. The bridge runs inside the
// iframe (sandbox="allow-scripts") and posts every link click and
// content-size change to the parent via `parent.postMessage`. That
// way the parent never has to reach into `iframe.contentDocument` —
// no more attach-handler-on-the-wrong-document races, no focus leaks
// onto anchors, no Esc-stops-working-after-click.
//
// Output is the full, ready-to-render HTML. The wsmail:// `/body/`
// protocol handler caches it on disk keyed by sha256(message_id) so
// we render once per email — re-opens are a single disk read.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use lol_html::{element, rewrite_str, RewriteStrSettings};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const STYLES: &str = r#"
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    color: #1f2328;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; }
  a { color: #1d4ed8; }
  table { max-width: 100% !important; }
  /* Note: we deliberately do NOT use `content-visibility: auto` here.
     It defers layout for off-screen blocks and uses
     `contain-intrinsic-size` as a stand-in until each block scrolls
     near. The placeholder never matches the real measurements, so
     every scroll (and every re-open, because layout starts deferred
     again) produces visible content shifts as the real sizes
     materialize. Letting the browser lay everything out upfront
     costs a few extra ms on first paint and keeps scroll position
     and content rock-stable across every open — the way Gmail
     handles it. */
"#;

// Inline bridge that runs inside the iframe (sandbox="allow-scripts").
// Kept ES5-ish so we don't depend on whatever WKWebView happens to
// support — no template literals, no optional chaining.
//
// IMPORTANT: this string is embedded inside `<script>...</script>`. It
// must not contain the literal sequence `</script>` anywhere.
const BRIDGE: &str = r#"
(function(){
  var rafId = null;
  function reportHeight() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(function() {
      rafId = null;
      var docEl = document.documentElement;
      var body = document.body;
      var h = Math.max(
        docEl ? docEl.scrollHeight : 0,
        body ? body.scrollHeight : 0
      );
      try { parent.postMessage({ type: 'wsmail-height', height: h }, '*'); } catch (e) {}
    });
  }
  function findAnchor(node) {
    while (node && node.nodeType === 1) {
      if (node.tagName === 'A' && node.getAttribute('href')) return node;
      node = node.parentNode;
    }
    return null;
  }
  document.addEventListener('mousedown', function(e) {
    if (findAnchor(e.target)) e.preventDefault();
  }, true);
  function dispatchClick(e) {
    var a = findAnchor(e.target);
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    e.preventDefault();
    try { parent.postMessage({ type: 'wsmail-link', href: href }, '*'); } catch (err) {}
  }
  document.addEventListener('click', dispatchClick, true);
  document.addEventListener('auxclick', dispatchClick, true);
  function start() {
    try {
      var ro = new ResizeObserver(reportHeight);
      if (document.documentElement) ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    } catch (e) {}
    reportHeight();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
"#;

fn img_cache_url(url: &str) -> String {
    let key = URL_SAFE_NO_PAD.encode(url.as_bytes());
    format!("wsmail://localhost/img/{}", key)
}

/// Extract every remote `<img src="http(s)://…">` URL referenced by
/// the raw email HTML. Used to look up cached image dimensions before
/// rendering so the renderer can emit `width`/`height` attrs.
pub fn extract_remote_image_urls(raw: &str) -> Vec<String> {
    let urls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let urls_clone = Arc::clone(&urls);
    let _ = rewrite_str(
        raw,
        RewriteStrSettings {
            element_content_handlers: vec![element!("img[src]", move |el| {
                if let Some(src) = el.get_attribute("src") {
                    let trimmed = src.trim_start();
                    let lower = trimmed.to_lowercase();
                    if lower.starts_with("http://") || lower.starts_with("https://") {
                        urls_clone.lock().unwrap().push(trimmed.to_string());
                    }
                }
                Ok(())
            })],
            ..RewriteStrSettings::default()
        },
    );
    Arc::try_unwrap(urls)
        .ok()
        .and_then(|m| m.into_inner().ok())
        .unwrap_or_default()
}

fn sanitize_and_rewrite(
    raw: &str,
    dimensions: HashMap<String, (u32, u32)>,
    load_remote_images: bool,
) -> Result<String, String> {
    let mut img_index: u32 = 0;

    rewrite_str(
        raw,
        RewriteStrSettings {
            element_content_handlers: vec![
                // Drop dangerous tags entirely (and their children). `head`
                // is in this list because we render inside our own wrapper
                // — keeping the email's head would nest <style>/<link>
                // tags inside our <body>, which browsers ignore but is
                // weird. Inline styles on the actual email elements still
                // apply.
                element!(
                    "script, style, iframe, object, embed, frame, frameset, base, head, link, form, input, button, select, option, textarea, video, audio, source, track, svg, math",
                    |el| {
                        el.remove();
                        Ok(())
                    }
                ),
                // Strip `<html>` / `<body>` tags but keep their content,
                // so the email body inlines cleanly into our own
                // document.
                element!("html, body", |el| {
                    el.remove_and_keep_content();
                    Ok(())
                }),
                element!("meta[http-equiv]", |el| {
                    let v = el
                        .get_attribute("http-equiv")
                        .unwrap_or_default()
                        .to_lowercase();
                    if v == "refresh" || v == "set-cookie" {
                        el.remove();
                    }
                    Ok(())
                }),
                element!("img", move |el| {
                    if el.get_attribute("loading").is_none() {
                        let _ = el.set_attribute("loading", "lazy");
                    }
                    if el.get_attribute("decoding").is_none() {
                        let _ = el.set_attribute("decoding", "async");
                    }
                    if el.get_attribute("fetchpriority").is_none() {
                        let pri = if img_index < 3 { "high" } else { "low" };
                        let _ = el.set_attribute("fetchpriority", pri);
                    }
                    img_index = img_index.saturating_add(1);
                    if let Some(src) = el.get_attribute("src") {
                        let trimmed = src.trim_start();
                        let lower = trimmed.to_lowercase();
                        if lower.starts_with("http://") || lower.starts_with("https://") {
                            // Emit `width`/`height` from the image
                            // cache before swapping `src`. Knowing the
                            // intrinsic pixel dimensions lets the
                            // browser reserve the correct box upfront
                            // (and `img { max-width: 100% }` from the
                            // wrapper styles still scales it down to
                            // panel width while preserving aspect
                            // ratio). Without this, every freshly
                            // loaded image pushes content below it.
                            if let Some(&(w, h)) = dimensions.get(trimmed) {
                                if !el.has_attribute("width") {
                                    let _ = el.set_attribute("width", &w.to_string());
                                }
                                if !el.has_attribute("height") {
                                    let _ = el.set_attribute("height", &h.to_string());
                                }
                            }
                            if load_remote_images {
                                let _ = el.set_attribute("src", &img_cache_url(trimmed));
                            } else {
                                // Remote images are tracking requests as well as
                                // content. Keep their alt text and dimensions but
                                // make no network request until the user opts in.
                                el.remove_attribute("src");
                                let _ = el.set_attribute("data-woodshed-remote-image", "blocked");
                            }
                        } else if lower.starts_with("javascript:") || lower.starts_with("data:") {
                            el.remove_attribute("src");
                        }
                    }
                    if el.has_attribute("srcset") {
                        el.remove_attribute("srcset");
                    }
                    Ok(())
                }),
                // Generic per-element pass: strip on* event handlers and
                // any javascript:/data: hrefs that slipped past the more
                // specific handlers above (or that come from non-<a>
                // navigable elements).
                element!("*", |el| {
                    let on_attrs: Vec<String> = el
                        .attributes()
                        .iter()
                        .filter(|a| a.name().to_lowercase().starts_with("on"))
                        .map(|a| a.name().to_string())
                        .collect();
                    for name in on_attrs {
                        el.remove_attribute(&name);
                    }
                    // CSS can make its own tracking requests via url(), so
                    // sender-controlled styles are excluded from this isolated
                    // document. Woodshed's wrapper supplies readable defaults.
                    el.remove_attribute("style");
                    el.remove_attribute("background");
                    el.remove_attribute("poster");
                    if let Some(href) = el.get_attribute("href") {
                        let lower = href.trim_start().to_lowercase();
                        if !(lower.starts_with("https://")
                            || lower.starts_with("http://")
                            || lower.starts_with("mailto:")
                            || lower.starts_with("tel:")
                            || lower.starts_with('#'))
                        {
                            el.remove_attribute("href");
                        }
                    }
                    Ok(())
                }),
            ],
            ..RewriteStrSettings::default()
        },
    )
    .map_err(|e| format!("rewrite: {e}"))
}

/// Render a sanitized + wrapped email body, ready to load via the
/// wsmail:// `/body/` URI scheme. `dimensions` maps original image
/// URLs to their intrinsic `(width, height)` so the renderer can emit
/// `width`/`height` attrs and the browser reserves the right box
/// before each image actually loads. Pass an empty map and the
/// renderer simply omits the dimensions (first-ever encounter with an
/// image URL — content shifts on first paint, but every subsequent
/// open of any email referencing that URL is stable).
pub fn render_email(
    raw_email_html: &str,
    dimensions: HashMap<String, (u32, u32)>,
    load_remote_images: bool,
) -> Result<String, String> {
    let sanitized = sanitize_and_rewrite(raw_email_html, dimensions, load_remote_images)?;
    let mut out = String::with_capacity(sanitized.len() + STYLES.len() + BRIDGE.len() + 256);
    out.push_str("<!doctype html>\n<html>\n<head>\n");
    out.push_str("<meta charset=\"utf-8\" />\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n");
    out.push_str("<style>");
    out.push_str(STYLES);
    out.push_str("</style>\n</head>\n<body>");
    out.push_str(&sanitized);
    out.push_str("\n<script>");
    out.push_str(BRIDGE);
    out.push_str("</script>\n</body>\n</html>");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_dims() -> HashMap<String, (u32, u32)> {
        HashMap::new()
    }

    #[test]
    fn strips_scripts_and_event_handlers() {
        let raw = r#"<p onclick="alert(1)">hi</p><script>alert(2)</script>"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        assert!(!out.contains("alert(1)"));
        assert!(!out.contains("alert(2)"));
        assert!(!out.contains("onclick"));
        assert!(out.contains(">hi<"));
    }

    #[test]
    fn unwraps_html_and_body() {
        let raw = r#"<html><head><style>x{}</style></head><body><p>hello</p></body></html>"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        let body_start = out.find("<body>").unwrap();
        let body_end = out.rfind("</body>").unwrap();
        let body_inner = &out[body_start + 6..body_end];
        assert!(!body_inner.contains("<html"));
        assert!(!body_inner.contains("<body"));
        assert!(body_inner.contains("<p>hello</p>"));
    }

    #[test]
    fn rewrites_remote_img_src_to_wsmail() {
        let raw = r#"<img src="https://cdn.example.com/x.png" />"#;
        let out = render_email(raw, empty_dims(), true).unwrap();
        assert!(out.contains("wsmail://localhost/img/"));
        assert!(out.contains("loading=\"lazy\""));
        assert!(out.contains("decoding=\"async\""));
        assert!(out.contains("fetchpriority=\"high\""));
    }

    #[test]
    fn drops_javascript_href() {
        let raw = r#"<a href="javascript:evil()">click</a>"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        assert!(!out.contains("javascript:"));
    }

    #[test]
    fn strips_css_and_embedded_active_content() {
        let raw = r#"<style>body{background:url(https://tracker.example/p)}</style>
            <p style="background:url(https://tracker.example/q)">hello</p>
            <form action="https://evil.example"><input name="secret"></form>
            <svg><script>alert(1)</script></svg>"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        assert!(!out.contains("tracker.example"));
        assert!(!out.contains("<form"));
        assert!(!out.contains("<input"));
        assert!(!out.contains("<svg"));
        assert!(out.contains("hello"));
    }

    #[test]
    fn keeps_normal_href() {
        let raw = r#"<a href="https://example.com" target="_blank">link</a>"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        assert!(out.contains("https://example.com"));
    }

    #[test]
    fn emits_width_and_height_when_dimensions_known() {
        let raw = r#"<img src="https://cdn.example.com/poster.png" />"#;
        let mut dims = HashMap::new();
        dims.insert(
            "https://cdn.example.com/poster.png".to_string(),
            (640u32, 480u32),
        );
        let out = render_email(raw, dims, true).unwrap();
        assert!(
            out.contains("width=\"640\""),
            "expected width attr in {out}"
        );
        assert!(
            out.contains("height=\"480\""),
            "expected height attr in {out}"
        );
    }

    #[test]
    fn keeps_existing_dimensions_when_email_already_has_them() {
        let raw = r#"<img src="https://cdn.example.com/poster.png" width="100" height="200" />"#;
        let mut dims = HashMap::new();
        dims.insert(
            "https://cdn.example.com/poster.png".to_string(),
            (640u32, 480u32),
        );
        let out = render_email(raw, dims, true).unwrap();
        // Email's own dimensions win; we only fill in when missing.
        assert!(out.contains("width=\"100\""));
        assert!(out.contains("height=\"200\""));
        assert!(!out.contains("width=\"640\""));
    }

    #[test]
    fn extract_remote_image_urls_finds_https_and_skips_data() {
        let raw = r#"<img src="https://a.com/1.png">
            <img src="data:image/png;base64,abc">
            <img src="HTTPS://b.com/2.jpg">"#;
        let urls = extract_remote_image_urls(raw);
        assert_eq!(urls.len(), 2);
        assert!(urls.iter().any(|u| u == "https://a.com/1.png"));
        assert!(urls.iter().any(|u| u == "HTTPS://b.com/2.jpg"));
    }

    #[test]
    fn blocks_remote_images_until_explicitly_loaded() {
        let raw = r#"<img src="https://tracker.example/pixel.png" alt="logo" />"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        assert!(!out.contains("wsmail://localhost/img/"));
        assert!(!out.contains("https://tracker.example/pixel.png"));
        assert!(out.contains("data-woodshed-remote-image=\"blocked\""));
        assert!(out.contains("alt=\"logo\""));
    }
}
