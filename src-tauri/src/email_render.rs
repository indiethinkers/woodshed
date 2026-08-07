// Email body render pipeline.
//
// Takes the raw HTML the sender shipped (from the .html sibling next to
// each email's .md), runs a single streaming pass with `lol_html` to
//
//   - strip dangerous content (`<script>`, `<iframe>`, `<object>`,
//     `<embed>`, `<frame>`, `<frameset>`, `<base>`, `<head>`,
//     `<meta http-equiv="refresh|set-cookie">`, on* event-handler
//     attributes, `javascript:`/`data:` hrefs, `javascript:` srcs)
//   - keep inline `style` attributes minus any declaration that could
//     fetch (see `sanitize_style_attribute`) — emails carry their whole
//     layout there, including the `display: none` that hides preheaders
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
    /* `break-word`, not `anywhere`: `anywhere` also collapses a word's
       min-content to a single character, which makes auto-layout tables
       honor narrow authored column widths by crushing the text inside
       them — GitHub's 24px-wide "Status" header renders as one vertical
       letter per line. `break-word` still wraps long tokens (URLs) when
       they exceed the line box, but leaves intrinsic table sizing alone. */
    word-wrap: break-word;
    overflow-wrap: break-word;
    /* Sender colours assume a light canvas, so the document owns one
       explicitly rather than inheriting the app's theme and leaving dark-mode
       readers with #333 text on a dark background. The email's own body tag is
       unwrapped (and with it any background it set), so without this the canvas
       is whatever the sender's outermost table happens to paint — which reads
       as a stray white block floating in the pane. */
    background: #ffffff;
  }
  /* `!important` because inline styles now survive sanitization: a sender's
     `width: 900px` on an image would otherwise overflow the pane horizontally.
     `height` stays overridable so spacer images keep their explicit heights. */
  img { max-width: 100% !important; height: auto; }
  [data-woodshed-remote-image="blocked"] { display: none !important; }
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

  /* Gmail-style quoted-history toggle ("Show trimmed content"),
     injected by QUOTE_TRIM for HTML bodies. Matches the app's
     plaintext trim toggle: small, muted, chevron, hover fill. */
  .ws-trim-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 12px 0 4px;
    padding: 2px 6px;
    border: 0;
    border-radius: 4px;
    background: none;
    font-family: inherit;
    font-size: 12px;
    color: #6b7280;
    cursor: pointer;
  }
  .ws-trim-toggle:hover {
    color: #111827;
    background: rgba(17, 24, 39, 0.06);
  }
  .ws-trim-chevron { font-size: 10px; line-height: 1; }
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
  // The body iframe is always sized to its content and never scrolls
  // internally, so a wheel over an email would die inside the frame.
  // Forward it to the parent's scroll container so scrolling over an
  // email behaves like scrolling over any other page.
  document.addEventListener('wheel', function(e) {
    if (e.ctrlKey) return;
    if (e.deltaX === 0 && e.deltaY === 0) return;
    e.preventDefault();
    try { parent.postMessage({ type: 'wsmail-wheel', deltaX: e.deltaX, deltaY: e.deltaY }, '*'); } catch (err) {}
  }, { passive: false });
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

// Gmail-style "Show trimmed content" for HTML bodies. Replies almost
// always carry the full conversation quoted below the new text; the
// plaintext path trims it in the React tree (splitQuotedBody), but HTML
// bodies render inside this iframe, so the collapse lives here. The
// script finds where the quoted section starts (Gmail's gmail_quote
// wrapper, Apple Mail's blockquote, or a "wrote:" attribution line),
// hides it, and inserts a toggle that reveals it. Every message with a
// quoted tail trims by default — even when the quote dwarfs the reply
// (a one-line "I agree!" over a wall of history still reads as just
// "I agree!"). Only two exceptions stay fully visible: a quoted tail
// too short to be real history (signature footer, "Sent from my
// iPhone"), and a message whose body IS the quoted history with no
// text of its own above it (a forward — nothing would remain to read).
//
// IMPORTANT: this string is embedded inside `<script>...</script>`. It
// must not contain the literal sequence `</script>` anywhere.
const QUOTE_TRIM: &str = r#"
(function(){
  function visibleText(node) {
    return node && node.textContent ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  function findQuoteStart() {
    // Gmail wraps the quoted history in a div.gmail_quote (the
    // "On ... wrote:" attribution lives just inside it).
    var gq = document.querySelector('.gmail_quote');
    if (gq) return gq;
    // Apple Mail wraps it in a blockquote with type="cite".
    var bq = document.querySelector('blockquote[type="cite"], blockquote[cite]');
    if (bq) return bq;
    // Fallback: the first block-level element whose text opens with a
    // "wrote:" attribution line or a classic quote separator.
    var kids = document.body ? document.body.children : [];
    for (var i = 0; i < kids.length; i++) {
      var t = visibleText(kids[i]);
      if (/^(On\s+.+wrote:|-----Original Message-----|---------- Forwarded message ----------|>)/i.test(t)) {
        return kids[i];
      }
    }
    return null;
  }
  function hasTextBefore(node) {
    // Walk the node's previous siblings — and, at each ancestor level,
    // that ancestor's previous siblings — looking for any visible text.
    // A reply has its own text above the quote; a forward does not.
    var cur = node;
    while (cur && cur.parentNode) {
      var sib = cur.previousSibling;
      while (sib) {
        if (sib.nodeType === 1) {
          if (visibleText(sib).length > 0) return true;
        } else if (sib.nodeType === 3) {
          if ((sib.textContent || '').trim().length > 0) return true;
        }
        sib = sib.previousSibling;
      }
      cur = cur.parentNode;
    }
    return false;
  }
  function reportHeight() {
    var docEl = document.documentElement;
    var body = document.body;
    var h = Math.max(docEl ? docEl.scrollHeight : 0, body ? body.scrollHeight : 0);
    try { parent.postMessage({ type: 'wsmail-height', height: h }, '*'); } catch (e) {}
  }
  var quote = findQuoteStart();
  if (!quote) return;
  var quotedText = visibleText(quote);
  // Too short to be real history — a signature tail or a one-line
  // "Sent from my iPhone" reads better in place than behind a toggle.
  if (quotedText.length < 120) return;
  // A forward (body IS the quoted history, no text above it) must not
  // collapse to nothing — there'd be no message left to read.
  if (!hasTextBefore(quote)) return;

  var open = false;
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ws-trim-toggle';
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span class="ws-trim-chevron">\u25BE</span> Show trimmed content';
  btn.addEventListener('click', function() {
    open = !open;
    quote.style.display = open ? '' : 'none';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.innerHTML = open
      ? '<span class="ws-trim-chevron">\u25B4</span> Hide trimmed content'
      : '<span class="ws-trim-chevron">\u25BE</span> Show trimmed content';
    // Tell the parent this was a user interaction: the click happens
    // inside the sandboxed iframe, so it never reaches EmailDetail's
    // pointerdown listener. Without this, expanding trimmed content on
    // the newest message grows the thread and the ResizeObserver yanks
    // the view back down to the reply strip.
    try { parent.postMessage({ type: 'wsmail-interaction' }, '*'); } catch (e) {}
    reportHeight();
  });
  quote.parentNode.insertBefore(btn, quote);
  quote.style.display = 'none';
  reportHeight();
})();
"#;

// ─── Inline style sanitization ───────────────────────────────────────────────
//
// Email layout lives almost entirely in inline `style` attributes, and the
// single most important thing they do is *hide* content: every sender puts a
// preheader (the preview line the inbox list shows) in a `display: none` block,
// and ships desktop and mobile variants of the same block with one hidden.
// Dropping the attribute wholesale unhides all of it, collapses spacer heights,
// and leaves the reader looking at a truncated preview line and duplicated
// sections.
//
// So we keep declarations and drop the ones that can act. The only thing CSS
// can do from inside an opaque sandboxed frame is fetch — which would break the
// invariant that sender HTML never reaches the network directly — so that is
// what the filter targets. `EMAIL_BODY_CSP` on the `/body/` response is the
// structural backstop if anything here is ever wrong.

/// Declarations whose value can start a network request, or that hand control
/// to a legacy scripting hook. Matched as substrings of the normalized value.
const FETCHING_CSS_TOKENS: [&str; 7] = [
    "url(",
    "image(",
    "image-set(",
    "element(",
    "expression(",
    "@import",
    "-moz-binding",
];

/// Properties dropped regardless of value: `src` only means anything inside
/// `@font-face` (which cannot appear in an attribute), and the other two are
/// legacy scripting hooks.
const DENIED_CSS_PROPERTIES: [&str; 3] = ["src", "behavior", "-moz-binding"];

/// Decode the HTML entities that can appear inside a `style` attribute.
///
/// `lol_html` hands back attribute values exactly as written, entities and all,
/// so this has to happen before anything else. It is not cosmetic: without it
/// `background: &#117;rl(https://tracker/p)` reads as a harmless literal to the
/// token filter and is then decoded into `url(` by the browser. Decoding first
/// means the filter sees what the browser will see.
///
/// Unknown or malformed sequences are left as written — a stray `&` in a CSS
/// value is meaningless, so there is nothing to gain by guessing.
fn decode_html_entities(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            let ch_len = raw[i..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&raw[i..i + ch_len]);
            i += ch_len;
            continue;
        }
        // Entities are short; a `;` further out than this isn't one.
        let limit = (i + 12).min(bytes.len());
        match raw[i..limit].find(';') {
            Some(offset) => {
                let entity = &raw[i + 1..i + offset];
                let decoded = match entity.to_ascii_lowercase().as_str() {
                    "quot" | "#34" | "#x22" => Some('"'),
                    "apos" | "#39" | "#x27" => Some('\''),
                    "amp" | "#38" | "#x26" => Some('&'),
                    "lt" | "#60" | "#x3c" => Some('<'),
                    "gt" | "#62" | "#x3e" => Some('>'),
                    "#40" | "#x28" => Some('('),
                    "#41" | "#x29" => Some(')'),
                    // Any other numeric reference: decode it so the filter sees
                    // the same character the browser will.
                    other => other
                        .strip_prefix('#')
                        .and_then(|digits| match digits.strip_prefix('x') {
                            Some(hex) => u32::from_str_radix(hex, 16).ok(),
                            None => digits.parse::<u32>().ok(),
                        })
                        .and_then(char::from_u32),
                };
                match decoded {
                    Some(c) => {
                        out.push(c);
                        i += offset + 1;
                    }
                    None => {
                        out.push('&');
                        i += 1;
                    }
                }
            }
            None => {
                out.push('&');
                i += 1;
            }
        }
    }
    out
}

/// Escape a sanitized value for writing back into a double-quoted attribute.
/// `set_attribute` writes bytes verbatim, so an unescaped `"` would close the
/// attribute early.
fn encode_attribute_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// Split a declaration list on `;`, ignoring separators inside quoted strings.
/// `font-family: "Foo;Bar", serif` is one declaration, not two.
fn split_css_declarations(value: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut quote: Option<char> = None;
    let mut start = 0;
    for (index, c) in value.char_indices() {
        match (quote, c) {
            (Some(open), _) if c == open => quote = None,
            (None, '"') | (None, '\'') => quote = Some(c),
            (None, ';') => {
                out.push(&value[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    out.push(&value[start..]);
    out
}

/// Sanitize one inline `style` attribute. Returns `None` when nothing
/// survives, so the caller can drop the attribute instead of leaving `style=""`.
/// The result is entity-decoded; the caller escapes it on the way back out.
fn sanitize_style_attribute(raw: &str) -> Option<String> {
    let decoded = decode_html_entities(raw);
    let mut kept: Vec<String> = Vec::new();
    for declaration in split_css_declarations(&decoded) {
        let declaration = declaration.trim();
        if declaration.is_empty() {
            continue;
        }
        // Split on the first colon only: values legitimately contain colons
        // (`background: url(https://…)`, though that one is dropped below).
        let Some((property, value)) = declaration.split_once(':') else {
            continue;
        };
        let property = property.trim().to_lowercase();
        let value = value.trim();
        if property.is_empty() || value.is_empty() {
            continue;
        }
        if !property
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            continue;
        }
        if DENIED_CSS_PROPERTIES.contains(&property.as_str()) {
            continue;
        }
        // Backslash escapes (`\75 rl(`) and comments (`u/**/rl(`) both exist to
        // spell a token without writing it literally. Real email HTML uses
        // neither, so rejecting them outright beats trying to decode them.
        if value.contains('\\') || value.contains("/*") {
            continue;
        }
        let lowered = value.to_lowercase();
        if FETCHING_CSS_TOKENS
            .iter()
            .any(|token| lowered.contains(token))
        {
            continue;
        }
        kept.push(format!("{property}: {value}"));
    }
    (!kept.is_empty()).then(|| kept.join("; "))
}

fn img_cache_url(url: &str) -> String {
    let key = URL_SAFE_NO_PAD.encode(url.as_bytes());
    format!("wsmail://localhost/img/{}", key)
}

fn is_inline_image_data_url(src: &str) -> bool {
    src.trim_start()
        .to_ascii_lowercase()
        .starts_with("data:image/")
}

/// Normalize a remote image URL for cache lookup and rewriting.
/// Protocol-relative URLs (`//cdn.example/x.png`) become `https://…`.
fn normalize_remote_image_url(src: &str) -> Option<String> {
    let trimmed = src.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(trimmed.to_string());
    }
    if trimmed.starts_with("//") {
        return Some(format!("https:{trimmed}"));
    }
    None
}

fn first_remote_url_from_srcset(srcset: &str) -> Option<String> {
    for candidate in srcset.split(',') {
        let url = candidate.trim().split_whitespace().next()?.trim();
        if let Some(normalized) = normalize_remote_image_url(url) {
            return Some(normalized);
        }
    }
    None
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
            element_content_handlers: vec![element!("img", move |el| {
                if let Some(src) = el.get_attribute("src") {
                    if let Some(normalized) = normalize_remote_image_url(&src) {
                        urls_clone.lock().unwrap().push(normalized);
                    }
                } else if let Some(srcset) = el.get_attribute("srcset") {
                    if let Some(normalized) = first_remote_url_from_srcset(&srcset) {
                        urls_clone.lock().unwrap().push(normalized);
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
                    // The iframe grows to match its document and does not own
                    // the outer scroll viewport. WebKit can leave a lazy image
                    // permanently "below the fold": the image waits for a
                    // larger iframe while the iframe waits for image layout.
                    if load_remote_images {
                        let _ = el.set_attribute("loading", "eager");
                    } else if el.get_attribute("loading").is_none() {
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
                    let mut src = el.get_attribute("src");
                    if src.as_ref().is_none_or(|value| value.trim().is_empty()) {
                        if let Some(srcset) = el.get_attribute("srcset") {
                            if let Some(fallback) = first_remote_url_from_srcset(&srcset) {
                                let _ = el.set_attribute("src", &fallback);
                                src = Some(fallback);
                            }
                        }
                    }
                    if let Some(src) = src {
                        let trimmed = src.trim();
                        if is_inline_image_data_url(trimmed) {
                            // Inline data URLs are allowed by EMAIL_BODY_CSP.
                        } else if let Some(remote) = normalize_remote_image_url(trimmed) {
                            if let Some(&(w, h)) = dimensions.get(&remote) {
                                if !el.has_attribute("width") {
                                    let _ = el.set_attribute("width", &w.to_string());
                                }
                                if !el.has_attribute("height") {
                                    let _ = el.set_attribute("height", &h.to_string());
                                }
                            }
                            if load_remote_images {
                                let _ = el.set_attribute("src", &img_cache_url(&remote));
                            } else {
                                el.remove_attribute("src");
                                let _ =
                                    el.set_attribute("data-woodshed-remote-image", "blocked");
                            }
                        } else {
                            let lower = trimmed.to_ascii_lowercase();
                            if lower.starts_with("javascript:")
                                || (lower.starts_with("data:") && !is_inline_image_data_url(trimmed))
                            {
                                el.remove_attribute("src");
                            }
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
                    // Keep the sender's layout, drop anything in it that could
                    // fetch. See `sanitize_style_attribute`.
                    match el
                        .get_attribute("style")
                        .as_deref()
                        .and_then(sanitize_style_attribute)
                    {
                        Some(safe) => {
                            let _ = el.set_attribute("style", &encode_attribute_value(&safe));
                        }
                        None => el.remove_attribute("style"),
                    }
                    // `background` is a bare URL with no property to filter,
                    // and `poster` only applies to the media elements we drop.
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
    out.push_str(QUOTE_TRIM);
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
    fn bridge_forwards_wheels_to_the_parent_scroll_container() {
        let out = render_email("<p>hi</p>", empty_dims(), false).unwrap();
        // The body iframe is auto-height and never scrolls internally, so
        // the bridge must forward wheel deltas to the parent page.
        assert!(out.contains("wsmail-wheel"));
        assert!(out.contains("deltaY"));
    }

    #[test]
    fn html_bodies_carry_the_quoted_history_collapse_script() {
        let out = render_email("<p>hi</p>", empty_dims(), false).unwrap();
        // HTML bodies skip the React-side splitQuotedBody trim, so the
        // iframe gets the Gmail-style "Show trimmed content" collapse.
        assert!(out.contains("ws-trim-toggle"));
        assert!(out.contains("Show trimmed content"));
        assert!(out.contains("gmail_quote"));
        assert!(out.contains("blockquote"));
        // Every message with a quoted tail trims by default; only a
        // forward (no text above the quote) and tiny signature tails
        // stay fully visible. The hasTextBefore guard is what keeps a
        // short reply over a huge quoted wall trimmed.
        assert!(out.contains("hasTextBefore"));
    }

    #[test]
    fn quote_trim_script_never_contains_a_closing_script_tag() {
        let out = render_email("<p>hi</p>", empty_dims(), false).unwrap();
        // The BRIDGE + QUOTE_TRIM are embedded inside one <script>
        // element; the literal "</script>" would terminate it early and
        // leave the rest of the string as raw HTML.
        let script_start = out.find("<script>").unwrap();
        let script_end = out.find("</script>").unwrap();
        let script_body = &out[script_start + "<script>".len()..script_end];
        assert!(!script_body.contains("</script>"));
    }

    #[test]
    fn gmail_quote_wrappers_survive_sanitization() {
        let raw = r#"<div dir="ltr">real content</div><div class="gmail_quote"><div>On Tue, Jan 5, 2027 at 9:00 AM X <x@example.com> wrote:</div><blockquote type="cite">quoted history</blockquote></div>"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        // The collapse script needs the structural markers intact to find
        // where the quoted history starts.
        assert!(out.contains("gmail_quote"));
        assert!(out.contains("<blockquote type=\"cite\">"), "in {out}");
        assert!(out.contains("real content"));
    }

    #[test]
    fn injected_styles_do_not_crush_table_column_min_content() {
        let out = render_email("<p>hi</p>", empty_dims(), false).unwrap();
        // `overflow-wrap: anywhere` collapses a word's min-content to one
        // character, so auto-layout tables honor narrow authored widths by
        // stacking the text vertically (GitHub's 24px "Status" column).
        // `break-word` wraps long tokens without that intrinsic-size side
        // effect.
        assert!(out.contains("overflow-wrap: break-word"));
        assert!(!out.contains("overflow-wrap: anywhere"));
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
    fn rewrites_remote_images_for_automatic_eager_loading() {
        let raw = r#"<img src="https://cdn.example.com/x.png" loading="lazy" />"#;
        let out = render_email(raw, empty_dims(), true).unwrap();
        assert!(out.contains("wsmail://localhost/img/"));
        assert!(out.contains("loading=\"eager\""));
        assert!(!out.contains("loading=\"lazy\""));
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
    fn strips_fetching_css_and_embedded_active_content() {
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

    // The reported bug. Every sender hides a preheader — the preview line the
    // inbox list shows — in a `display: none` block. Dropping the style
    // attribute rendered that line at the top of the message, truncated
    // mid-word, above the real content. This is the exact attribute shape from
    // the email that surfaced it.
    #[test]
    fn a_hidden_preheader_stays_hidden() {
        let raw = r#"<span class="preheader" style="color: transparent; display: none; height: 0; max-height: 0; max-width: 0; opacity: 0; overflow: hidden; mso-hide: all; visibility: hidden; width: 0;">preview line</span><p>real body</p>"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        assert!(out.contains("display: none"), "in {out}");
        assert!(out.contains("max-height: 0"));
        assert!(out.contains("visibility: hidden"));
        assert!(out.contains("real body"));
    }

    #[test]
    fn a_fetching_declaration_is_dropped_without_losing_its_neighbours() {
        let kept = sanitize_style_attribute(
            "padding: 24px; background: url(https://tracker.example/p); font-size: 15px",
        )
        .expect("safe declarations survive");
        assert_eq!(kept, "padding: 24px; font-size: 15px");
    }

    #[test]
    fn every_fetching_css_function_is_rejected() {
        for value in [
            "background: url(https://a.example/p)",
            "background: URL('https://a.example/p')",
            "background-image: image-set(\"https://a.example/p\" 1x)",
            "background-image: -webkit-image-set(\"https://a.example/p\" 1x)",
            "background: image('https://a.example/p')",
            "background: element(#other)",
            "width: expression(alert(1))",
            "behavior: url(#default#time2)",
            "-moz-binding: url(https://a.example/x.xml)",
        ] {
            assert!(
                sanitize_style_attribute(value).is_none(),
                "expected {value} to be rejected entirely"
            );
        }
    }

    // `\75 rl(` and `u/**/rl(` both spell `url(` without writing it. Real email
    // HTML uses neither, so any value carrying an escape or a comment is
    // dropped rather than decoded.
    #[test]
    fn css_escapes_and_comments_are_rejected_rather_than_decoded() {
        assert!(sanitize_style_attribute(r"background: \75 rl(https://a.example/p)").is_none());
        assert!(sanitize_style_attribute("background: u/**/rl(https://a.example/p)").is_none());
        assert!(sanitize_style_attribute(r"content: \0041").is_none());
    }

    #[test]
    fn a_style_attribute_with_nothing_safe_left_is_removed_entirely() {
        assert!(sanitize_style_attribute("background: url(https://a.example/p)").is_none());
        assert!(sanitize_style_attribute("   ").is_none());
        assert!(sanitize_style_attribute(";;;").is_none());
        assert!(sanitize_style_attribute("novalue:").is_none());

        let raw = r#"<p style="background:url(https://a.example/p)">hi</p>"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        assert!(
            !out.contains("style="),
            "empty style attr left behind: {out}"
        );
    }

    #[test]
    fn a_malformed_property_name_is_dropped() {
        // Anything that isn't an identifier can't be a real property, and
        // letting it through would mean trusting the value scan alone.
        assert!(sanitize_style_attribute("colo r: red").is_none());
        assert!(sanitize_style_attribute("}\ncolor: red").is_none());
        assert_eq!(
            sanitize_style_attribute("-webkit-text-size-adjust: 100%").as_deref(),
            Some("-webkit-text-size-adjust: 100%"),
        );
    }

    // lol_html hands attribute values back exactly as written, so an entity
    // spelling of `url(` would read as a harmless literal to the token filter
    // and then be decoded by the browser. Decode before filtering, always.
    #[test]
    fn entity_encoded_fetch_tokens_do_not_slip_past_the_filter() {
        for value in [
            "background: &#117;rl(https://a.example/p)",
            "background: &#x75;rl(https://a.example/p)",
            "background: u&#114;l(https://a.example/p)",
            "background: url&#40;https://a.example/p&#41;",
        ] {
            assert!(
                sanitize_style_attribute(value).is_none(),
                "expected {value} to be rejected after entity decoding"
            );
        }
    }

    // Quoted font names are entity-escaped in real email HTML, and the `;`
    // inside `&quot;` used to split the declaration — mangling the font stack
    // and taking the following declaration down with it.
    #[test]
    fn entity_escaped_font_stacks_survive_intact() {
        let kept = sanitize_style_attribute(
            "font-family: &quot;Google Sans&quot;, Roboto, sans-serif; color: red",
        )
        .expect("font stack survives");
        assert_eq!(
            kept,
            "font-family: \"Google Sans\", Roboto, sans-serif; color: red"
        );

        // …and it round-trips back into the attribute correctly.
        let raw = r#"<p style="font-family: &quot;Google Sans&quot;, Roboto; color: red">hi</p>"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        assert!(
            out.contains(r#"style="font-family: &quot;Google Sans&quot;, Roboto; color: red""#),
            "attribute did not round-trip in {out}"
        );
    }

    #[test]
    fn a_semicolon_inside_a_quoted_value_is_not_a_declaration_separator() {
        assert_eq!(
            split_css_declarations("font-family: \"Foo;Bar\", serif; color: red").len(),
            2
        );
        let kept = sanitize_style_attribute("font-family: \"Foo;Bar\", serif; color: red")
            .expect("both survive");
        assert!(kept.contains("\"Foo;Bar\""), "got {kept}");
        assert!(kept.contains("color: red"));
    }

    #[test]
    fn unknown_and_malformed_entities_are_left_alone() {
        assert_eq!(decode_html_entities("a &notreal; b"), "a &notreal; b");
        assert_eq!(decode_html_entities("50% & rising"), "50% & rising");
        assert_eq!(decode_html_entities("&amp;quot;"), "&quot;");
        assert_eq!(decode_html_entities("&#8212;"), "—");
    }

    #[test]
    fn layout_declarations_emails_depend_on_survive() {
        let kept = sanitize_style_attribute(
            "mso-hide: all; font-family: Georgia, serif; line-height: 1.4; \
             text-align: center; border-collapse: collapse; height: 20px; \
             background-color: #f6f6f6; background: linear-gradient(#fff, #eee)",
        )
        .expect("layout declarations survive");
        for expected in [
            "mso-hide: all",
            "font-family: Georgia, serif",
            "text-align: center",
            "height: 20px",
            "background-color: #f6f6f6",
            "linear-gradient(#fff, #eee)",
        ] {
            assert!(kept.contains(expected), "{expected} missing from {kept}");
        }
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
            <img src="HTTPS://b.com/2.jpg">
            <img src="//c.com/3.webp">"#;
        let urls = extract_remote_image_urls(raw);
        assert_eq!(urls.len(), 3);
        assert!(urls.iter().any(|u| u == "https://a.com/1.png"));
        assert!(urls.iter().any(|u| u == "HTTPS://b.com/2.jpg"));
        assert!(urls.iter().any(|u| u == "https://c.com/3.webp"));
    }

    #[test]
    fn rewrites_protocol_relative_images_for_automatic_eager_loading() {
        let raw = r#"<img src="//cdn.example.com/x.png" />"#;
        let out = render_email(raw, empty_dims(), true).unwrap();
        assert!(out.contains("wsmail://localhost/img/"));
        assert!(!out.contains(r#"src="//cdn.example.com/x.png""#));
    }

    #[test]
    fn keeps_inline_data_image_urls() {
        let raw = r#"<img src="data:image/png;base64,abc" alt="logo" />"#;
        let out = render_email(raw, empty_dims(), true).unwrap();
        assert!(out.contains(r#"src="data:image/png;base64,abc""#));
    }

    #[test]
    fn falls_back_to_srcset_when_src_is_missing() {
        let raw = r#"<img srcset="//cdn.example.com/x.png 1x, //cdn.example.com/x2.png 2x" alt="hero" />"#;
        let out = render_email(raw, empty_dims(), true).unwrap();
        assert!(out.contains("wsmail://localhost/img/"));
        assert!(!out.contains("srcset="));
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

    #[test]
    fn blocked_remote_images_do_not_render_broken_placeholders() {
        let raw = r#"<img src="https://tracker.example/hero.png" alt="hero" width="1200" height="600" />"#;
        let out = render_email(raw, empty_dims(), false).unwrap();
        assert!(
            out.contains("[data-woodshed-remote-image=\"blocked\"]"),
            "blocked image CSS must collapse sender-sized placeholders: {out}"
        );
        assert!(
            out.contains("display: none !important"),
            "blocked images must not occupy layout space: {out}"
        );
    }
}
