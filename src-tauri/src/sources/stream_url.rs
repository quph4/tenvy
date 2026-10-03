//! Guards for stream URLs that came from a provider's playlist.
//!
//! Playlist contents are untrusted: any non-comment line in an M3U becomes a
//! `stream_url`. Those URLs are handed to mpv (embedded and external) and
//! VLC, and they routinely embed account credentials, so they need checking
//! before use and scrubbing before they reach a log or an error message.

use crate::err;
use crate::error::Result;

/// Schemes a live/VOD stream can legitimately use. Anything else — local
/// paths, `file://`, mpv pseudo-protocols like `edl://` or `lavfi://` —
/// is refused rather than passed to a player.
const ALLOWED_SCHEMES: &[&str] = &[
    "http", "https", "rtmp", "rtmps", "rtmpt", "rtmpe", "rtsp", "rtsps", "rtp", "udp", "srt",
    "mms", "mmsh",
];

/// Reject anything that isn't a well-formed network URL with an allowed
/// scheme. In particular a value starting with `-` would be parsed as a
/// command-line option by mpv/VLC (e.g. `--script=\\host\share\x.lua`).
pub fn validate(url: &str) -> Result<()> {
    if url.starts_with('-') {
        return Err(err!("Refusing to play a stream URL that looks like a command-line option"));
    }
    let parsed = url::Url::parse(url).map_err(|_| err!("Invalid stream URL"))?;
    if !ALLOWED_SCHEMES.contains(&parsed.scheme()) {
        return Err(err!("Unsupported stream URL scheme: {}", parsed.scheme()));
    }
    Ok(())
}

/// Credential-free rendering of a URL for logs and user-facing errors.
///
/// Masks userinfo, credential-ish query parameters, and the
/// `/{kind}/{user}/{pass}/` path segments of Xtream stream URLs.
pub fn redact(url: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(url) else {
        return "<invalid url>".into();
    };
    if !parsed.username().is_empty() {
        let _ = parsed.set_username("***");
    }
    if parsed.password().is_some() {
        let _ = parsed.set_password(Some("***"));
    }

    if parsed.query().is_some() {
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(k, v)| {
                let secret = matches!(
                    k.to_ascii_lowercase().as_str(),
                    "username" | "user" | "password" | "pass" | "pwd" | "token" | "key" | "auth"
                );
                (k.into_owned(), if secret { "***".into() } else { v.into_owned() })
            })
            .collect();
        parsed.query_pairs_mut().clear().extend_pairs(pairs);
    }

    let segments: Option<Vec<String>> =
        parsed.path_segments().map(|s| s.map(str::to_string).collect());
    if let Some(mut segs) = segments {
        let refs: Vec<&str> = segs.iter().map(String::as_str).collect();
        if let Some((u, p)) = crate::sources::xtream::credential_segments(&refs) {
            segs[u] = "***".into();
            segs[p] = "***".into();
            parsed.set_path(&segs.join("/"));
        }
    }
    parsed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_option_injection_and_odd_schemes() {
        assert!(validate("--script=\\\\evil\\x.lua").is_err());
        assert!(validate("C:\\movies\\a.mkv").is_err());
        assert!(validate("file:///C:/a.mkv").is_err());
        assert!(validate("edl://x").is_err());
        assert!(validate("http://h/live/u/p/1.ts").is_ok());
        assert!(validate("rtmp://h/app/stream").is_ok());
    }

    #[test]
    fn redacts_xtream_and_query_credentials() {
        assert_eq!(
            redact("http://h:8080/movie/alice/s3cret/42.mkv"),
            "http://h:8080/movie/***/***/42.mkv"
        );
        let r = redact("http://h/get.php?username=alice&password=s3cret&type=m3u");
        assert!(!r.contains("alice") && !r.contains("s3cret") && r.contains("type=m3u"));
        assert!(!redact("http://bob:pw@h/x").contains("pw"));
        assert_eq!(redact("http://h:2095/alice/s3cret/24639"), "http://h:2095/***/***/24639");
        assert_eq!(
            redact("http://h:2095/timeshift/alice/s3cret/30/2026-10-03:13-20/24639.ts"),
            "http://h:2095/timeshift/***/***/30/2026-10-03:13-20/24639.ts"
        );
    }
}
