//! Settings Tenvy reads from the web at startup, so the business model,
//! the support link and announcements can change without shipping a new
//! version. The file lives next to the website (GitHub Pages today); if a
//! custom domain is added later, Pages redirects and old versions follow.
//!
//! Everything here fails open: no network, a broken file or an unknown
//! model all mean "free, no extras". A typo in the config must never lock
//! anyone out of the app.

use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const CONFIG_URL: &str = "https://quph4.github.io/tenvy-releases/config.json";

/// Longest text shown from the config; anything longer is cut.
const MAX_TEXT: usize = 280;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteConfig {
    /// "free" today. Later versions may understand others (e.g. "trial");
    /// this version treats anything it doesn't know as free.
    pub model: String,
    /// Where "Support Tenvy" leads (donations). Hidden when absent.
    pub support: Option<SupportLink>,
    /// When to gently ask for support. No prompt when absent.
    pub support_prompt: Option<SupportPrompt>,
    /// Where people talk, ask and report (the Discord). Hidden when absent.
    pub community: Option<CommunityLink>,
    /// One-off messages, each shown once per install.
    pub announcements: Vec<Announcement>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SupportLink {
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
    /// The sentence in the occasional prompt.
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityLink {
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SupportPrompt {
    /// Days after installing before the first prompt.
    pub after_days: u32,
    /// Days between prompts.
    pub every_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub url: Option<String>,
    /// Inclusive version range this applies to, e.g. to tell users of an
    /// old version something specific.
    #[serde(default)]
    pub min_version: Option<String>,
    #[serde(default)]
    pub max_version: Option<String>,
}

impl RemoteConfig {
    /// Drop what this version can't or shouldn't show: non-https links,
    /// announcements for other versions, overlong text, unknown models.
    pub fn sanitized(mut self, version: &str) -> Self {
        if !matches!(self.model.as_str(), "free") {
            self.model = "free".into();
        }
        self.support = self.support.filter(|s| is_https(&s.url)).map(|mut s| {
            s.label = s.label.map(|t| clip(&t)).filter(|t| !t.is_empty());
            s.message = s.message.map(|t| clip(&t)).filter(|t| !t.is_empty());
            s
        });
        self.support_prompt = self.support_prompt.filter(|p| p.every_days > 0);
        self.community = self.community.filter(|c| is_https(&c.url)).map(|mut c| {
            c.label = c.label.map(|t| clip(&t)).filter(|t| !t.is_empty());
            c
        });
        self.announcements = self
            .announcements
            .into_iter()
            .filter(|a| !a.id.is_empty() && !a.text.trim().is_empty())
            .filter(|a| a.url.as_deref().is_none_or(is_https))
            .filter(|a| in_range(version, a.min_version.as_deref(), a.max_version.as_deref()))
            .map(|mut a| {
                a.text = clip(&a.text);
                a
            })
            .collect();
        self
    }
}

/// Fetch the config. Errors (offline, 404, bad JSON) are the caller's to
/// fall back from.
pub async fn fetch(http: &reqwest::Client) -> crate::error::Result<RemoteConfig> {
    // Development builds can read it from elsewhere (the test provider).
    let url = std::env::var("TENVY_CONFIG_URL")
        .ok()
        .filter(|_| cfg!(debug_assertions))
        .unwrap_or_else(|| CONFIG_URL.to_string());
    let body = http
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    Ok(serde_json::from_str(&body)?)
}

fn is_https(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some())
}

fn clip(text: &str) -> String {
    let t = text.trim();
    match t.char_indices().nth(MAX_TEXT) {
        Some((i, _)) => format!("{}…", t[..i].trim_end()),
        None => t.to_string(),
    }
}

/// "1.2.3" → (1, 2, 3); missing or non-numeric parts count as 0, and a
/// pre-release suffix ("1.2.3-beta") is ignored.
fn version_tuple(v: &str) -> (u64, u64, u64) {
    let mut parts = v
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

fn in_range(version: &str, min: Option<&str>, max: Option<&str>) -> bool {
    let v = version_tuple(version);
    min.is_none_or(|m| v >= version_tuple(m)) && max.is_none_or(|m| v <= version_tuple(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_partial_files_parse() {
        let c: RemoteConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c.sanitized("0.1.0").model, "free");
        let c: RemoteConfig =
            serde_json::from_str(r#"{"model":"free","futureField":1,"support":{"url":"https://ko-fi.com/x"}}"#)
                .unwrap();
        assert_eq!(c.support.unwrap().url, "https://ko-fi.com/x");
        let c: RemoteConfig =
            serde_json::from_str(r#"{"community":{"url":"https://discord.gg/abc","label":"Join the Discord"}}"#).unwrap();
        assert_eq!(c.sanitized("0.1.0").community.unwrap().label.as_deref(), Some("Join the Discord"));
    }

    #[test]
    fn unknown_models_fail_open() {
        let c = RemoteConfig { model: "paid-only".into(), ..Default::default() };
        assert_eq!(c.sanitized("0.1.0").model, "free");
    }

    #[test]
    fn unsafe_links_are_dropped() {
        let c = RemoteConfig {
            support: Some(SupportLink { url: "javascript:alert(1)".into(), label: None, message: None }),
            announcements: vec![Announcement {
                id: "a".into(),
                text: "hi".into(),
                url: Some("http://example.com".into()),
                min_version: None,
                max_version: None,
            }],
            ..Default::default()
        }
        .sanitized("0.1.0");
        assert!(c.support.is_none());
        assert!(c.announcements.is_empty());
        let c = RemoteConfig {
            community: Some(CommunityLink { url: "http://discord.gg/x".into(), label: None }),
            ..Default::default()
        }
        .sanitized("0.1.0");
        assert!(c.community.is_none());
    }

    #[test]
    fn announcements_respect_version_range() {
        let a = |min: Option<&str>, max: Option<&str>| Announcement {
            id: "a".into(),
            text: "hi".into(),
            url: None,
            min_version: min.map(Into::into),
            max_version: max.map(Into::into),
        };
        let keep = |ann| {
            !RemoteConfig { announcements: vec![ann], ..Default::default() }
                .sanitized("0.2.0")
                .announcements
                .is_empty()
        };
        assert!(keep(a(None, None)));
        assert!(keep(a(Some("0.2.0"), Some("0.2.0"))));
        assert!(keep(a(None, Some("0.10.0"))));
        assert!(!keep(a(None, Some("0.1.9"))));
        assert!(!keep(a(Some("0.2.1"), None)));
    }

    #[test]
    fn long_text_is_clipped() {
        let c = RemoteConfig {
            support: Some(SupportLink {
                url: "https://x.y".into(),
                label: Some("  ".into()),
                message: Some("å".repeat(400)),
            }),
            ..Default::default()
        }
        .sanitized("0.1.0");
        let s = c.support.unwrap();
        assert!(s.label.is_none());
        assert_eq!(s.message.unwrap().chars().count(), MAX_TEXT + 1);
    }
}
