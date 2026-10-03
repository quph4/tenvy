use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::db::ChannelInsert;
use crate::error::Result;
use crate::models::Programme;
use crate::err;

/// Minimal Xtream Codes client.
/// Endpoint: `{host}/player_api.php?username=…&password=…&action=…`.
/// Output format: `{host}/live/{user}/{pass}/{stream_id}.{ext}`.
pub struct Xtream {
    pub host: String,
    pub username: String,
    pub password: String,
    client: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct Category {
    category_id: String,
    category_name: String,
}

#[derive(Debug, Deserialize)]
struct LiveStream {
    #[serde(default)]
    stream_id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    stream_icon: Option<String>,
    #[serde(default)]
    category_id: Option<String>,
    #[serde(default)]
    epg_channel_id: Option<String>,
    #[serde(default)]
    container_extension: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ShortEpgWrap {
    #[serde(default)]
    epg_listings: Vec<ShortEpgItem>,
}

#[derive(Debug, Deserialize)]
struct ShortEpgItem {
    title: Option<String>,
    description: Option<String>,
    #[serde(default)]
    start_timestamp: Option<String>,
    #[serde(default)]
    stop_timestamp: Option<String>,
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
}

impl Xtream {
    pub fn new(host: &str, username: &str, password: &str) -> Result<Self> {
        let host = host.trim_end_matches('/').to_string();
        // Validate early
        reqwest::Url::parse(&host).map_err(|_| err!("Invalid Xtream host URL"))?;
        Ok(Self {
            host,
            username: username.to_string(),
            password: password.to_string(),
            client: reqwest::Client::builder()
                .user_agent("Lumen/0.1 (+https://lumen.local)")
                .timeout(std::time::Duration::from_secs(30))
                .build()?,
        })
    }

    fn api_url(&self, action: &str, extra: &[(&str, &str)]) -> Result<reqwest::Url> {
        let mut url = reqwest::Url::parse(&format!("{}/player_api.php", self.host))?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("username", &self.username);
            q.append_pair("password", &self.password);
            q.append_pair("action", action);
            for (k, v) in extra {
                q.append_pair(k, v);
            }
        }
        Ok(url)
    }

    pub async fn fetch_channels(&self) -> Result<Vec<ChannelInsert>> {
        // Categories → id → name
        let cats: Vec<Category> = self
            .client
            .get(self.api_url("get_live_categories", &[])?)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        // Trim category names — Xtream providers often pad them with
        // spaces *and* zero-width characters (intentional sort tricks, or
        // careless data entry), which then shows up as weird indentation
        // in the sidebar. `m3u::clean` covers both.
        let cat_map: HashMap<String, String> = cats
            .into_iter()
            .map(|c| (c.category_id, crate::sources::m3u::clean(&c.category_name)))
            .collect();

        let streams: Vec<LiveStream> = self
            .client
            .get(self.api_url("get_live_streams", &[])?)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        Ok(streams
            .into_iter()
            .map(|s| {
                let ext = s.container_extension.unwrap_or_else(|| "m3u8".into());
                let stream_url = format!(
                    "{}/live/{}/{}/{}.{}",
                    self.host, self.username, self.password, s.stream_id, ext
                );
                ChannelInsert {
                    tvg_id: trim_opt(s.epg_channel_id),
                    name: crate::sources::m3u::clean(&s.name),
                    logo: trim_opt(s.stream_icon),
                    group: s.category_id.and_then(|id| cat_map.get(&id).cloned()),
                    stream_url,
                    kind: "live".into(),
                }
            })
            .collect())
    }

    /// Fetch short EPG for a single stream (handful of upcoming programmes).
    pub async fn fetch_short_epg(&self, stream_id: i64, tvg_id: &str) -> Result<Vec<Programme>> {
        let wrap: ShortEpgWrap = self
            .client
            .get(self.api_url(
                "get_short_epg",
                &[("stream_id", &stream_id.to_string()), ("limit", "8")],
            )?)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let mut out = Vec::with_capacity(wrap.epg_listings.len());
        for item in wrap.epg_listings {
            let start = parse_ts(item.start_timestamp.as_deref(), item.start.as_deref());
            let stop = parse_ts(item.stop_timestamp.as_deref(), item.end.as_deref());
            if let (Some(start), Some(stop)) = (start, stop) {
                out.push(Programme {
                    channel_tvg_id: tvg_id.to_string(),
                    start,
                    stop,
                    title: item.title.unwrap_or_default(),
                    description: item.description.filter(|s| !s.is_empty()),
                });
            }
        }
        Ok(out)
    }
}

/// Clean an optional string and drop it if it came out empty. Mirrors
/// `m3u::non_empty` so both ingest paths agree on what "blank" means
/// (including Unicode zero-width padding).
fn trim_opt(s: Option<String>) -> Option<String> {
    s.map(|v| crate::sources::m3u::clean(&v)).filter(|v| !v.is_empty())
}

// ------------- VOD probe -------------

/// One audio or subtitle track as reported by the provider's ffprobe. `index`
/// is the original stream index inside the container — useful as a stable id
/// and it's what mpv/VLC show too, so our labels match what the user sees
/// after pressing X.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbedTrack {
    pub index: i64,
    pub codec: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
    /// "Stereo" / "5.1" / "Mono" — only meaningful for audio tracks.
    pub channel_layout: Option<String>,
    pub is_default: bool,
}

/// Result of probing a VOD URL via Xtream's `get_vod_info` endpoint. Shape
/// is normalised so the frontend doesn't care which fields a given provider
/// actually populated.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProbedTracks {
    pub audio: Vec<ProbedTrack>,
    pub subtitle: Vec<ProbedTrack>,
    /// Provider that answered — currently always "xtream"; here so we can
    /// extend this to other probe sources (e.g. bundled ffprobe) without
    /// reshaping the API.
    pub provider: String,
}

/// Xtream URL parts extracted from a stream URL.
/// Pattern: `{scheme}://{host}[:port]/{movie|series|live}/{user}/{pass}/{id}.{ext}`.
pub struct XtreamUrl {
    pub host: String,
    pub username: String,
    pub password: String,
    /// "movie" | "series" | "live". Part of a channel's stable identity
    /// across refreshes (see `db::channel_key`).
    pub kind: String,
    pub stream_id: i64,
}

/// Parse an Xtream-formatted stream URL. Returns `None` for anything that
/// doesn't match the expected shape — e.g. generic M3U streams from non-Xtream
/// providers, which we can't probe.
pub fn parse_xtream_url(url: &str) -> Option<XtreamUrl> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let segments: Vec<&str> = parsed.path_segments()?.collect();
    // Expect exactly 4 segments: [kind, user, pass, "{id}.{ext}"]
    if segments.len() < 4 {
        return None;
    }
    let kind = match segments[0] {
        "movie" | "series" | "live" => segments[0].to_string(),
        _ => return None,
    };
    let id_with_ext = segments[3];
    // Strip extension (".mkv" / ".mp4" / ".m3u8" etc.) if present. Extensionless
    // URLs are also valid (e.g. some live Xtream streams).
    let id_str = id_with_ext
        .rsplit_once('.')
        .map(|(a, _)| a)
        .unwrap_or(id_with_ext);
    let stream_id: i64 = id_str.parse().ok()?;

    // Reconstruct host (scheme + host + optional port) — drop path/query.
    let scheme = parsed.scheme();
    let host = parsed.host_str()?;
    let host_full = if let Some(port) = parsed.port() {
        format!("{}://{}:{}", scheme, host, port)
    } else {
        format!("{}://{}", scheme, host)
    };

    Some(XtreamUrl {
        host: host_full,
        username: segments[1].to_string(),
        password: segments[2].to_string(),
        kind,
        stream_id,
    })
}

impl Xtream {
    /// Fetch ffprobe-style track metadata for a VOD. Works for Xtream movie
    /// URLs; series episodes fall through to `get_vod_info` too since a lot
    /// of panels alias them — when they don't, the endpoint returns empty
    /// and we just surface no extras.
    pub async fn probe_vod(&self, vod_id: i64) -> Result<ProbedTracks> {
        let vod_id_str = vod_id.to_string();
        let url = self.api_url("get_vod_info", &[("vod_id", &vod_id_str)])?;
        let resp = self.client.get(url).send().await?.error_for_status()?;
        let text = resp.text().await?;
        // Some panels return `[]` when the id is unknown instead of a proper
        // error. serde_json lets us detect that before trying the real shape.
        if text.trim() == "[]" || text.trim().is_empty() {
            return Ok(ProbedTracks {
                provider: "xtream".into(),
                ..Default::default()
            });
        }
        let root: VodInfoRoot = serde_json::from_str(&text).map_err(|e| {
            err!("get_vod_info parse failed: {} (body: {})", e, truncate(&text, 200))
        })?;
        Ok(normalize_vod_info(root))
    }
}

fn truncate(s: &str, n: usize) -> &str {
    if s.len() <= n { s } else { &s[..n] }
}

// ------------- get_vod_info JSON shapes -------------
//
// Xtream panels are famously inconsistent about this endpoint. The field we
// care about is `info`, which carries an ffprobe dump. Different panels put
// the streams in different places:
//   - Some return `info.audio` (single) + `info.audio_additional` (extras)
//   - Some return `info.streams` (full ffprobe array, mixed audio+video+subs)
//   - Some return `info.subtitles` as a pre-split list
//
// We parse whichever arrived and fold them into a single normalised list.

#[derive(Debug, Deserialize)]
struct VodInfoRoot {
    #[serde(default)]
    info: Option<VodInfo>,
}

#[derive(Debug, Deserialize, Default)]
struct VodInfo {
    #[serde(default)]
    audio: Option<FfStream>,
    #[serde(default)]
    audio_additional: Vec<FfStream>,
    #[serde(default)]
    subtitles: Vec<FfStream>,
    #[serde(default)]
    streams: Vec<FfStream>,
}

/// Slice of an ffprobe stream entry — only the fields we actually use, all
/// optional because every panel picks a different subset.
#[derive(Debug, Deserialize, Default)]
struct FfStream {
    #[serde(default)]
    index: Option<i64>,
    #[serde(default)]
    codec_type: Option<String>,
    #[serde(default)]
    codec_name: Option<String>,
    #[serde(default)]
    channel_layout: Option<String>,
    #[serde(default)]
    channels: Option<i64>,
    #[serde(default)]
    tags: Option<FfTags>,
    #[serde(default)]
    disposition: Option<FfDisposition>,
}

#[derive(Debug, Deserialize, Default)]
struct FfTags {
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "handler_name")]
    handler_name: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct FfDisposition {
    #[serde(default)]
    default: Option<i64>,
}

fn normalize_vod_info(root: VodInfoRoot) -> ProbedTracks {
    let Some(info) = root.info else {
        return ProbedTracks {
            provider: "xtream".into(),
            ..Default::default()
        };
    };

    let mut audio: Vec<ProbedTrack> = Vec::new();
    let mut subtitle: Vec<ProbedTrack> = Vec::new();

    // Path 1: `streams` is the full ffprobe array — walk it and split by type.
    for s in &info.streams {
        match s.codec_type.as_deref() {
            Some("audio") => audio.push(to_probed(s, true)),
            Some("subtitle") => subtitle.push(to_probed(s, false)),
            _ => {}
        }
    }

    // Path 2: per-type arrays. Only use these if `streams` didn't already
    // give us what we need — some panels duplicate the info across both.
    if audio.is_empty() {
        if let Some(primary) = &info.audio {
            audio.push(to_probed(primary, true));
        }
        for s in &info.audio_additional {
            audio.push(to_probed(s, true));
        }
    }
    if subtitle.is_empty() {
        for s in &info.subtitles {
            subtitle.push(to_probed(s, false));
        }
    }

    ProbedTracks {
        audio,
        subtitle,
        provider: "xtream".into(),
    }
}

fn to_probed(s: &FfStream, is_audio: bool) -> ProbedTrack {
    let tags = s.tags.as_ref();
    let language = tags.and_then(|t| t.language.clone()).filter(|v| !v.is_empty());
    // Prefer explicit `tags.title`; fall back to `handler_name` when it's
    // something informative (mp4 containers often stash "SoundHandler" here,
    // which isn't — filter those out).
    let title = tags
        .and_then(|t| t.title.clone())
        .or_else(|| {
            tags.and_then(|t| t.handler_name.clone()).filter(|h| {
                let lower = h.to_ascii_lowercase();
                !lower.is_empty()
                    && !lower.contains("handler")
                    && !lower.contains("mainconcept")
            })
        })
        .filter(|v| !v.is_empty());

    let channel_layout = if is_audio {
        s.channel_layout
            .clone()
            .filter(|v| !v.is_empty())
            .or_else(|| {
                s.channels.and_then(|n| match n {
                    1 => Some("Mono".into()),
                    2 => Some("Stereo".into()),
                    6 => Some("5.1".into()),
                    7 => Some("6.1".into()),
                    8 => Some("7.1".into()),
                    n if n > 0 => Some(format!("{}ch", n)),
                    _ => None,
                })
            })
    } else {
        None
    };

    ProbedTrack {
        index: s.index.unwrap_or(0),
        codec: s.codec_name.clone().filter(|v| !v.is_empty()),
        language,
        title,
        channel_layout,
        is_default: s.disposition.as_ref().and_then(|d| d.default).unwrap_or(0) != 0,
    }
}

/// Xtream returns timestamps as either `"1700000000"` or `"2024-01-01 12:00:00"`.
#[allow(dead_code)]
fn parse_ts(secs: Option<&str>, datetime: Option<&str>) -> Option<i64> {
    if let Some(s) = secs {
        if let Ok(n) = s.parse::<i64>() {
            return Some(n);
        }
    }
    if let Some(dt) = datetime {
        if let Ok(t) = chrono::NaiveDateTime::parse_from_str(dt, "%Y-%m-%d %H:%M:%S") {
            return Some(t.and_utc().timestamp());
        }
    }
    None
}

