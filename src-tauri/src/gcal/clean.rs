// Description cleaning + meeting-link extraction for iCal events.
//
// Google Calendar (and most calendar providers) populates the
// `DESCRIPTION` field of a VEVENT with a chimerical mix of plain
// text, HTML, and Google-redirect URLs:
//
//   Join Zoom Meeting https://...zoom.us/j/...
//   Joining instructions: https://www.google.com/url?q=https://...zoom.us/...&sa=D&...
//   Meeting host: <a href="mailto:...">...</a><br /><br />Join Zoom Meeting: ...
//
// `clean_description` strips HTML tags, unescapes entities, unwraps
// the Google redirect wrapper, and collapses repeated blank lines so
// the result looks like a clean paragraph the user can read.
//
// `extract_meeting_url` detects Zoom / Google Meet / Microsoft Teams /
// Webex URLs (in the description OR the LOCATION field, since calendar
// providers vary on where they put it) and returns the first match
// for surfacing as a prominent "Join meeting" affordance.

/// Return a normalized plain-text version of a calendar DESCRIPTION
/// value. Strips HTML, unescapes entities, unwraps Google-redirect
/// URLs, and squashes runs of blank lines.
pub fn clean_description(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let no_html = strip_html(raw);
    let entities = unescape_entities(&no_html);
    let unwrapped = unwrap_google_redirects(&entities);
    collapse_blank_lines(&unwrapped)
}

/// Find the first conference URL we recognize. Looks at the description
/// body and (because Google sometimes puts it there) the location field.
pub fn extract_meeting_url(description: &str, location: Option<&str>) -> Option<String> {
    // The cleaned description is what users will eventually see; do the
    // extraction on the cleaned form so unwrapped redirects yield
    // canonical URLs.
    let cleaned = clean_description(description);
    if let Some(url) = scan_for_meeting_url(&cleaned) {
        return Some(url);
    }
    if let Some(loc) = location {
        if let Some(url) = scan_for_meeting_url(loc) {
            return Some(url);
        }
    }
    None
}

fn scan_for_meeting_url(text: &str) -> Option<String> {
    // Walk URLs in the text and return the first one whose host matches
    // a known conference provider. Order matters when multiple URLs
    // appear: Zoom typically appears before any fallback "joining
    // instructions" redirect, so first-wins gives the right answer.
    tokenize_urls(text)
        .into_iter()
        .find(|token| is_meeting_url(token))
}

fn is_meeting_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    // Match known conferencing hosts. Subdomains for Zoom workspaces
    // (`acme.zoom.us`) and Webex tenants (`acme.webex.com`) need
    // `contains` rather than exact-host comparison.
    lower.contains("zoom.us/j/")
        || lower.contains("zoom.us/my/")
        || lower.contains("meet.google.com/")
        || lower.contains("meet.jit.si/")
        || lower.contains("teams.microsoft.com/l/meetup-join/")
        || lower.contains("teams.live.com/meet/")
        || lower.contains("webex.com/meet/")
        || lower.contains("webex.com/j.php")
        || lower.contains("whereby.com/")
}

/// Walk a string and yield every `http(s)://` URL. Cheap state machine
/// because URLs can carry any visible non-whitespace character —
/// `regex` would need careful tuning to avoid grabbing trailing punctuation.
fn tokenize_urls(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Lookahead for "http" prefix.
        let prefix_len = if bytes[i..].starts_with(b"https://") {
            8
        } else if bytes[i..].starts_with(b"http://") {
            7
        } else {
            i += 1;
            continue;
        };
        let start = i;
        let mut end = i + prefix_len;
        while end < bytes.len() {
            let c = bytes[end];
            if c.is_ascii_whitespace() || c == b'<' || c == b'>' || c == b'"' {
                break;
            }
            end += 1;
        }
        // Trim trailing punctuation that almost certainly isn't part of the URL.
        let mut e = end;
        while e > start + prefix_len {
            let c = bytes[e - 1];
            if matches!(c, b'.' | b',' | b';' | b':' | b')' | b']' | b'}') {
                e -= 1;
                continue;
            }
            break;
        }
        if let Ok(s) = std::str::from_utf8(&bytes[start..e]) {
            out.push(s.to_string());
        }
        i = end.max(i + 1);
    }
    out
}

/// Best-effort HTML strip. Calendar descriptions only contain `<a>`,
/// `<br>`, `<p>`, `<span>`, and `<div>` in practice. Anchor tags get
/// their text preserved; everything else is dropped. `<br>` becomes
/// a newline because that's what the visible layout would have been.
fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // Find the closing `>`.
            let close = match bytes[i + 1..].iter().position(|&b| b == b'>') {
                Some(off) => i + 1 + off,
                None => {
                    out.push('<');
                    i += 1;
                    continue;
                }
            };
            let tag = std::str::from_utf8(&bytes[i + 1..close])
                .unwrap_or("")
                .trim();
            let tag_lower = tag.to_ascii_lowercase();
            if tag_lower.starts_with("br")
                || tag_lower.starts_with("/p")
                || tag_lower.starts_with("/div")
            {
                out.push('\n');
            }
            // All other tags: drop the markup, keep any text that
            // appears between open+close (handled by the outer loop).
            i = close + 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Unescape the small set of HTML entities calendar providers emit.
fn unescape_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        if bytes[i] != b'&' {
            out.push(bytes[i] as char);
            i += 1;
            continue;
        }
        // Look up to the next 8 bytes for a `;` terminator.
        let end = bytes[i..]
            .iter()
            .take(10)
            .position(|&b| b == b';')
            .map(|off| i + off);
        let Some(end) = end else {
            out.push('&');
            i += 1;
            continue;
        };
        let entity = std::str::from_utf8(&bytes[i + 1..end]).unwrap_or("");
        match entity {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" | "#39" => out.push('\''),
            "nbsp" => out.push(' '),
            _ => {
                out.push('&');
                i += 1;
                continue;
            }
        }
        i = end + 1;
    }
    out
}

/// Replace `https://www.google.com/url?q=<inner>&sa=D&...` wrappers
/// with `<inner>`, URL-decoded once. Google Calendar wraps every URL
/// in the description for tracking; users only care about the inner
/// destination. Idempotent on inputs that don't contain the wrapper.
fn unwrap_google_redirects(s: &str) -> String {
    let needle = "https://www.google.com/url?q=";
    let alt_needle = "http://www.google.com/url?q=";
    if !s.contains(needle) && !s.contains(alt_needle) {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let (matched, hit_len) = match (rest.find(needle), rest.find(alt_needle)) {
            (Some(a), Some(b)) if a <= b => (Some(a), needle.len()),
            (Some(a), None) => (Some(a), needle.len()),
            (None, Some(b)) => (Some(b), alt_needle.len()),
            (Some(_), Some(b)) => (Some(b), alt_needle.len()),
            (None, None) => (None, 0),
        };
        let Some(start) = matched else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let after = &rest[start + hit_len..];
        // Inner URL runs until `&sa=`, `&source=`, or any whitespace.
        // Whichever appears first wins.
        let end_offsets = [
            after.find("&sa="),
            after.find("&source="),
            after.find("&usg="),
            after.find(char::is_whitespace),
        ];
        let inner_end = end_offsets
            .iter()
            .flatten()
            .min()
            .copied()
            .unwrap_or(after.len());
        let inner = &after[..inner_end];
        let decoded = percent_decode(inner);
        out.push_str(&decoded);
        // Skip the entire redirect URL — fast-forward past `usg=...`
        // (and the trailing token, which is `&` separated).
        let tail = &after[inner_end..];
        let post_redirect = match tail.find(char::is_whitespace) {
            Some(off) => &tail[off..],
            None => "",
        };
        rest = post_redirect;
        if rest.is_empty() {
            break;
        }
    }
    out
}

/// Basic percent-decoding for the subset of characters Google's
/// redirect wrapper uses (`%3A`, `%2F`, `%3D`, `%26`, `%25`).
/// Handles nested encoding (`%253D` → `%3D` → `=`) by running twice.
fn percent_decode(input: &str) -> String {
    let once = percent_decode_once(input);
    if once.contains('%') {
        percent_decode_once(&once)
    } else {
        once
    }
}

fn percent_decode_once(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

/// Squash runs of three or more newlines down to two (single blank
/// line). Also trims leading/trailing whitespace.
fn collapse_blank_lines(s: &str) -> String {
    let trimmed = s.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut newline_run = 0;
    for c in trimmed.chars() {
        if c == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                out.push('\n');
            }
            continue;
        }
        newline_run = 0;
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html_anchor_and_br() {
        let input = "Meeting host: <a href=\"mailto:k@x.com\">k@x.com</a><br /><br />Join here";
        let cleaned = clean_description(input);
        assert!(cleaned.contains("Meeting host:"));
        assert!(!cleaned.contains("<a"));
        assert!(!cleaned.contains("<br"));
        assert!(cleaned.contains("Join here"));
    }

    #[test]
    fn unescapes_html_entities() {
        let cleaned = clean_description("a &amp; b &lt;c&gt;");
        assert_eq!(cleaned, "a & b <c>");
    }

    #[test]
    fn unwraps_google_redirect_to_zoom() {
        let input = "Join here: https://www.google.com/url?q=https://acme.zoom.us/j/123?pwd%3Dabc&sa=D&source=calendar&usg=AOvX foo";
        let cleaned = clean_description(input);
        assert!(cleaned.contains("https://acme.zoom.us/j/123?pwd=abc"));
        assert!(!cleaned.contains("google.com/url"));
        assert!(!cleaned.contains("usg="));
    }

    #[test]
    fn extracts_zoom_meeting_url_from_description() {
        let desc = "Join Zoom Meeting https://acme.zoom.us/j/82424797722?pwd=xyz (ID: ..., passcode: 015258)";
        let url = extract_meeting_url(desc, None).unwrap();
        assert!(url.starts_with("https://acme.zoom.us/j/"));
    }

    #[test]
    fn extracts_meet_url_from_location_when_description_has_none() {
        let url = extract_meeting_url(
            "see you there",
            Some("https://meet.google.com/abc-defg-hij"),
        );
        assert_eq!(url.as_deref(), Some("https://meet.google.com/abc-defg-hij"));
    }

    #[test]
    fn ignores_non_meeting_urls() {
        let url = extract_meeting_url("see https://example.com for info", None);
        assert!(url.is_none());
    }

    #[test]
    fn collapses_three_or_more_blank_lines() {
        let input = "one\n\n\n\ntwo";
        let cleaned = clean_description(input);
        assert_eq!(cleaned, "one\n\ntwo");
    }

    #[test]
    fn unwrapped_redirect_finds_zoom_under_double_encoding() {
        // Google sometimes double-encodes the inner URL when it itself
        // contains a query string. The percent-decode runs twice so
        // %253D becomes %3D becomes `=`.
        let input = "https://www.google.com/url?q=https://x.zoom.us/j/1?pwd%253Dabc&sa=D&source=calendar&usg=A foo";
        let url = extract_meeting_url(input, None).unwrap();
        assert!(url.contains("pwd=abc"));
    }
}
