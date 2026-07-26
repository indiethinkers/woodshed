use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use reqwest::{StatusCode, Url};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::OnceLock;
use std::time::Duration;

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_URL_BYTES: usize = 8 * 1024;
const MAX_CONCURRENT_PUBLIC_FETCHES: usize = 8;
static PUBLIC_FETCH_LIMIT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct PublicFetchOptions {
    pub max_bytes: usize,
    pub max_redirects: usize,
    pub timeout: Duration,
    pub user_agent: &'static str,
    pub accept: Option<&'static str>,
    pub https_only: bool,
}

#[derive(Debug)]
pub struct PublicResponse {
    pub final_url: Url,
    pub status: StatusCode,
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
}

pub fn validate_public_http_url(value: &str, https_only: bool) -> Result<Url, String> {
    let value = value.trim();
    if value.len() > MAX_URL_BYTES || value.chars().any(char::is_control) {
        return Err("public URL is too long or contains control characters".to_string());
    }
    let parsed = Url::parse(value).map_err(|_| "invalid public URL".to_string())?;
    match parsed.scheme() {
        "https" => {}
        "http" if !https_only => {}
        "http" => return Err("URL must use HTTPS".to_string()),
        _ => return Err("URL must use HTTP or HTTPS".to_string()),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("public URL cannot contain credentials".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "public URL must have a host".to_string())?;
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
        || normalized.ends_with(".internal")
    {
        return Err("public URL cannot target a local hostname".to_string());
    }
    let ip_text = normalized.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = ip_text.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err("public URL cannot target a non-public IP address".to_string());
        }
    }
    Ok(parsed)
}

/// Consume an arbitrary reqwest response without trusting Content-Length.
/// Used for user-configured and fixed-provider endpoints that intentionally
/// are not subject to the public-host SSRF policy.
pub async fn read_response_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > max_bytes)
    {
        return Err(format!("response exceeds {max_bytes} byte limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("read response: {e}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("response exceeds {max_bytes} byte limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub fn url_for_log(url: &Url) -> String {
    let mut redacted = url.clone();
    let _ = redacted.set_username("");
    let _ = redacted.set_password(None);
    redacted.set_query(None);
    redacted.set_fragment(None);
    redacted.to_string()
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    if a == 0 || a == 10 || a == 127 || a >= 224 {
        return false;
    }
    if a == 100 && (64..=127).contains(&b) {
        return false;
    }
    if a == 169 && b == 254 {
        return false;
    }
    if a == 172 && (16..=31).contains(&b) {
        return false;
    }
    if a == 192 && ((b == 168) || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)) {
        return false;
    }
    if a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)) {
        return false;
    }
    if a == 203 && b == 0 && c == 113 {
        return false;
    }
    true
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = ip.segments();
    if ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
    {
        return false;
    }
    // Only current global-unicast space is eligible. This conservatively
    // rejects discard-only, benchmarking, documentation, local-use NAT64,
    // and other special-purpose ranges outside 2000::/3.
    if (segments[0] & 0xe000) != 0x2000 {
        return false;
    }
    // Reject special allocations inside global-unicast space. In particular,
    // 6to4 can encode a private IPv4 destination and must never be treated as
    // a public SSRF target.
    if segments[0] == 0x2002
        || (segments[0] == 0x2001
            && (segments[1] == 0
                || segments[1] == 1
                || segments[1] == 2
                || segments[1] == 3
                || segments[1] == 0x0db8
                || (0x0010..=0x003f).contains(&segments[1])))
        || (segments[0] == 0x3fff && (segments[1] & 0xf000) == 0)
    {
        return false;
    }
    true
}

pub async fn fetch_public(
    initial_url: &str,
    options: &PublicFetchOptions,
) -> Result<PublicResponse, String> {
    let _permit = PUBLIC_FETCH_LIMIT
        .get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_PUBLIC_FETCHES))
        .acquire()
        .await
        .map_err(|_| "public fetch limiter is unavailable".to_string())?;
    let mut current = validate_public_http_url(initial_url, options.https_only)?;
    for redirect_count in 0..=options.max_redirects {
        let addresses = resolve_public_addresses(&current).await?;
        let host = current
            .host_str()
            .ok_or_else(|| "public URL must have a host".to_string())?;
        let mut builder = reqwest::Client::builder()
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .timeout(options.timeout)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(options.user_agent);
        let host_ip = host.trim_start_matches('[').trim_end_matches(']');
        if host_ip.parse::<IpAddr>().is_err() {
            builder = builder.resolve(host, addresses[0]);
        }
        let client = builder
            .build()
            .map_err(|e| format!("build public HTTP client: {e}"))?;
        let mut request = client.get(current.clone());
        if let Some(accept) = options.accept {
            request = request.header(reqwest::header::ACCEPT, accept);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("fetch {}: {e}", url_for_log(&current)))?;

        if response.status().is_redirection() {
            if redirect_count == options.max_redirects {
                return Err("public fetch exceeded redirect limit".to_string());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or_else(|| "redirect response omitted Location".to_string())?
                .to_str()
                .map_err(|_| "redirect Location was not valid text".to_string())?;
            let next = current
                .join(location)
                .map_err(|_| "redirect Location was not a valid URL".to_string())?;
            current = validate_public_http_url(next.as_str(), options.https_only)?;
            continue;
        }

        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "public fetch returned {status} for {}",
                url_for_log(&current)
            ));
        }
        if response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > options.max_bytes)
        {
            return Err(format!(
                "public response exceeds {} byte limit",
                options.max_bytes
            ));
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("read public response: {e}"))?
        {
            if bytes.len().saturating_add(chunk.len()) > options.max_bytes {
                return Err(format!(
                    "public response exceeds {} byte limit",
                    options.max_bytes
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(PublicResponse {
            final_url: current,
            status,
            content_type,
            bytes,
        });
    }
    Err("public fetch exceeded redirect limit".to_string())
}

async fn resolve_public_addresses(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "public URL must have a host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "public URL has no resolvable port".to_string())?;
    let host_ip = host.trim_start_matches('[').trim_end_matches(']');
    let addresses: Vec<SocketAddr> = if let Ok(ip) = host_ip.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::time::timeout(
            DEFAULT_CONNECT_TIMEOUT,
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| format!("resolve public host {host}: timed out"))?
        .map_err(|e| format!("resolve public host {host}: {e}"))?
        .collect()
    };
    if addresses.is_empty() {
        return Err(format!("public host {host} resolved to no addresses"));
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(format!(
            "public host {host} resolved to a non-public address"
        ));
    }
    Ok(addresses)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_url_accepts_normal_https_hosts() {
        let url = validate_public_http_url("https://example.com/article", false).unwrap();
        assert_eq!(url.host_str(), Some("example.com"));
    }

    #[test]
    fn public_url_rejects_local_and_private_targets() {
        for url in [
            "http://localhost/admin",
            "http://127.0.0.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.1/",
            "http://[::1]/",
            "file:///etc/passwd",
        ] {
            assert!(
                validate_public_http_url(url, false).is_err(),
                "expected public URL rejection: {url}"
            );
        }
    }

    #[test]
    fn public_url_rejects_credentials_controls_and_oversized_input() {
        assert!(validate_public_http_url("https://user:secret@example.com", false).is_err());
        assert!(validate_public_http_url("https://example.com/\nnext", false).is_err());
        let oversized = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert!(validate_public_http_url(&oversized, false).is_err());
    }

    #[test]
    fn https_only_mode_rejects_plaintext_urls() {
        assert!(validate_public_http_url("http://example.com/feed.ics", true).is_err());
    }

    #[test]
    fn url_for_log_drops_credentials_query_and_fragment() {
        let url = reqwest::Url::parse("https://user:secret@example.com/a?token=secret#x").unwrap();
        assert_eq!(url_for_log(&url), "https://example.com/a");
    }

    #[test]
    fn public_ip_classifier_rejects_non_global_ranges() {
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.1.1",
            "224.0.0.1",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "64:ff9b:1::1",
            "100::1",
            "2001:2::1",
            "2001:db8::1",
            "2002:0a00:0001::1",
            "3fff::1",
        ] {
            let parsed: std::net::IpAddr = ip.parse().unwrap();
            assert!(!is_public_ip(parsed), "expected non-public IP: {ip}");
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
}
