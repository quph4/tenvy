use std::collections::HashMap;

use serde_json::Value;

use crate::db::ChannelInsert;
use crate::models::{AccountInfo, VodDetails};
use crate::err;
use crate::error::Result;

/// Minimal Xtream Codes client.
/// Endpoint: `{host}/player_api.php?username=…&password=…&action=…`.
/// Stream URLs: `{host}/{live|movie|series}/{user}/{pass}/{id}.{ext}`.
///
/// Panels disagree wildly on JSON types (ids arrive as numbers or strings,
/// lists as arrays or id-keyed maps), so responses are read as loose
/// `serde_json::Value`s through the tolerant helpers at the bottom rather
/// than strict structs that would reject a whole catalogue over one field.
pub struct Xtream {
    host: String,
    username: String,
    password: String,
    client: reqwest::Client,
}

/// What a full catalogue fetch produced, per content kind.
pub struct Catalogue {
    pub channels: Vec<ChannelInsert>,
    pub live: usize,
    pub movies: usize,
    pub series: usize,
    /// Kinds that downloaded successfully. Only these may replace stored
    /// rows — a kind whose fetch failed keeps what we already have.
    pub kinds: Vec<&'static str>,
}

impl Xtream {
    pub fn new(host: &str, username: &str, password: &str, client: reqwest::Client) -> Result<Self> {
        let host = normalize_host(host)?;
        Ok(Self {
            host,
            username: username.to_string(),
            password: password.to_string(),
            client,
        })
    }

    pub fn xmltv_url(&self) -> String {
        let mut url = reqwest::Url::parse(&format!("{}/xmltv.php", self.host)).expect("validated host");
        url.query_pairs_mut()
            .append_pair("username", &self.username)
            .append_pair("password", &self.password);
        url.to_string()
    }

    fn api_url(&self, action: Option<&str>, extra: &[(&str, &str)]) -> Result<reqwest::Url> {
        let mut url = reqwest::Url::parse(&format!("{}/player_api.php", self.host))?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("username", &self.username);
            q.append_pair("password", &self.password);
            if let Some(action) = action {
                q.append_pair("action", action);
            }
            for (k, v) in extra {
                q.append_pair(k, v);
            }
        }
        Ok(url)
    }

    async fn get_json(&self, action: Option<&str>, extra: &[(&str, &str)]) -> Result<Value> {
        let resp = self
            .client
            .get(self.api_url(action, extra)?)
            .send()
            .await?
            .error_for_status()?;
        // Some panels send JSON with a text/html content type, or a BOM.
        let text = resp.text().await?;
        let text = text.trim_start_matches('\u{FEFF}').trim();
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(text).map_err(|_| {
            err!("The provider returned something that isn't Xtream JSON (action {:?})", action)
        })
    }

    /// Check credentials before downloading a catalogue, so a typo shows up
    /// as "wrong password" rather than an empty channel list.
    pub async fn authenticate(&self) -> Result<()> {
        let v = self.get_json(None, &[]).await?;
        let info = v.get("user_info").ok_or_else(|| {
            err!("This doesn't look like an Xtream Codes server. Check the host URL.")
        })?;
        if int(info, "auth") != Some(1) {
            return Err(err!("The provider rejected the username or password."));
        }
        if let Some(status) = string(info, "status") {
            if !status.eq_ignore_ascii_case("active") {
                return Err(err!("The provider reports this account as \"{}\".", status));
            }
        }
        Ok(())
    }

    /// Subscription status, expiry and connection limits.
    pub async fn account(&self) -> Result<AccountInfo> {
        let v = self.get_json(None, &[]).await?;
        let info = v.get("user_info").ok_or_else(|| err!("The provider didn't send account details."))?;
        Ok(account_from(info))
    }

    /// Fetch live channels, movies and series. Live failing is fatal; VOD
    /// and series are optional extras that many accounts don't include, so
    /// those degrade to empty with a warning.
    pub async fn fetch_catalogue(&self) -> Result<Catalogue> {
        self.authenticate().await?;

        let mut channels = Vec::new();

        let cats = self.categories("get_live_categories").await?;
        for s in &self.get_list("get_live_streams").await? {
            let Some(id) = int(s, "stream_id") else { continue };
            let ext = string(s, "container_extension").unwrap_or_else(|| "m3u8".into());
            channels.push(ChannelInsert {
                tvg_id: string(s, "epg_channel_id"),
                name: string(s, "name").unwrap_or_else(|| format!("Channel {}", id)),
                logo: string(s, "stream_icon"),
                group: string(s, "category_id").and_then(|c| cats.get(&c).cloned()),
                stream_url: self.stream_url("live", id, &ext),
                kind: "live".into(),
                archive_days: archive_days(s),
                ..Default::default()
            });
        }
        let live = channels.len();
        let mut kinds = vec!["live"];

        let movies_before = channels.len();
        match self.fetch_movies().await {
            Ok(mut m) => {
                channels.append(&mut m);
                kinds.push("movie");
            }
            Err(e) => tracing::warn!(target: "tenvy_lib", "xtream movies unavailable: {}", e),
        }
        let movies = channels.len() - movies_before;

        let series_before = channels.len();
        match self.fetch_series().await {
            Ok(mut s) => {
                channels.append(&mut s);
                kinds.push("series");
            }
            Err(e) => tracing::warn!(target: "tenvy_lib", "xtream series unavailable: {}", e),
        }
        let series = channels.len() - series_before;

        Ok(Catalogue { channels, live, movies, series, kinds })
    }

    async fn fetch_movies(&self) -> Result<Vec<ChannelInsert>> {
        let cats = self.categories("get_vod_categories").await?;
        Ok(self
            .get_list("get_vod_streams")
            .await?
            .iter()
            .filter_map(|s| {
                let id = int(s, "stream_id")?;
                let ext = string(s, "container_extension").unwrap_or_else(|| "mp4".into());
                let name = string(s, "name").unwrap_or_else(|| format!("Movie {}", id));
                Some(ChannelInsert {
                    year: crate::sources::m3u::year_in(&name),
                    name,
                    logo: string(s, "stream_icon").or_else(|| string(s, "cover")),
                    group: string(s, "category_id").and_then(|c| cats.get(&c).cloned()),
                    stream_url: self.stream_url("movie", id, &ext),
                    kind: "movie".into(),
                    rating: rating(s),
                    added: int(s, "added"),
                    ..Default::default()
                })
            })
            .collect())
    }

    /// Series are stored as *containers*: one row per show, with episodes
    /// fetched on demand by `fetch_episodes` when the user opens it. Pulling
    /// every show's episode list up front would mean thousands of requests.
    async fn fetch_series(&self) -> Result<Vec<ChannelInsert>> {
        let cats = self.categories("get_series_categories").await?;
        Ok(self
            .get_list("get_series")
            .await?
            .iter()
            .filter_map(|s| {
                let id = int(s, "series_id")?;
                let name = string(s, "name").unwrap_or_else(|| format!("Series {}", id));
                Some(ChannelInsert {
                    year: string(s, "releaseDate")
                        .or_else(|| string(s, "release_date"))
                        .and_then(|d| d.get(..4).and_then(|y| y.parse().ok()))
                        .or_else(|| crate::sources::m3u::year_in(&name)),
                    rating: rating(s),
                    added: int(s, "last_modified"),
                    name,
                    logo: string(s, "cover"),
                    group: string(s, "category_id").and_then(|c| cats.get(&c).cloned()),
                    // Not playable — identifies the show (see db::channel_key).
                    stream_url: format!("{}/series/{}/{}/{}", self.host, self.username, self.password, id),
                    kind: "series".into(),
                    container: true,
                    ..Default::default()
                })
            })
            .collect())
    }

    /// Episodes of one show, ordered by season then episode number.
    pub async fn fetch_episodes(&self, series_id: i64) -> Result<Vec<ChannelInsert>> {
        let v = self
            .get_json(Some("get_series_info"), &[("series_id", &series_id.to_string())])
            .await?;
        let cover = v.get("info").and_then(|i| string(i, "cover"));

        // `episodes` is usually `{ "1": [..], "2": [..] }` keyed by season,
        // but some panels send a bare array of season arrays.
        let seasons: Vec<&Value> = match v.get("episodes") {
            Some(Value::Object(map)) => map.values().collect(),
            Some(Value::Array(arr)) => arr.iter().collect(),
            _ => Vec::new(),
        };

        let mut out: Vec<ChannelInsert> = seasons
            .into_iter()
            .flat_map(array)
            .filter_map(|e| {
                let id = int(e, "id")?;
                let ext = string(e, "container_extension").unwrap_or_else(|| "mp4".into());
                let season = int(e, "season");
                let episode = int(e, "episode_num");
                let info = e.get("info");
                Some(ChannelInsert {
                    name: string(e, "title").unwrap_or_else(|| format!("Episode {}", episode.unwrap_or(0))),
                    logo: info.and_then(|i| string(i, "movie_image")).or_else(|| cover.clone()),
                    stream_url: self.stream_url("series", id, &ext),
                    kind: "series".into(),
                    season,
                    episode,
                    ..Default::default()
                })
            })
            .collect();
        if out.is_empty() {
            // Most likely a transient panel failure; the caller falls back
            // to cached episodes rather than wiping them.
            return Err(err!("The provider returned no episodes for this series."));
        }
        out.sort_by_key(|e| (e.season.unwrap_or(0), e.episode.unwrap_or(0)));
        Ok(out)
    }

    /// A list endpoint. An empty body or a non-array response is an error,
    /// not "zero items": overloaded panels do both, and treating that as an
    /// empty catalogue would delete the user's channels on refresh.
    async fn get_list(&self, action: &str) -> Result<Vec<Value>> {
        match self.get_json(Some(action), &[]).await? {
            Value::Array(items) => Ok(items),
            _ => Err(err!("The provider returned no data for {}. Try again later.", action)),
        }
    }

    async fn categories(&self, action: &str) -> Result<HashMap<String, String>> {
        // Names are cleaned with `m3u::clean`: providers pad them with
        // spaces and zero-width characters as sort hacks, which shows up
        // as odd indentation in the sidebar.
        Ok(self
            .get_list(action)
            .await?
            .iter()
            .filter_map(|c| {
                Some((string(c, "category_id")?, crate::sources::m3u::clean(&string(c, "category_name")?)))
            })
            .collect())
    }

    fn stream_url(&self, kind: &str, id: i64, ext: &str) -> String {
        format!("{}/{}/{}/{}/{}.{}", self.host, kind, self.username, self.password, id, ext)
    }

    /// Details page data for a movie (`get_vod_info`).
    pub async fn vod_details(&self, vod_id: i64) -> Result<VodDetails> {
        let v = self.get_json(Some("get_vod_info"), &[("vod_id", &vod_id.to_string())]).await?;
        let info = v.get("info").cloned().unwrap_or(Value::Null);
        Ok(VodDetails {
            plot: string(&info, "plot").or_else(|| string(&info, "description")),
            genre: string(&info, "genre"),
            cast: string(&info, "cast").or_else(|| string(&info, "actors")),
            director: string(&info, "director"),
            release_date: string(&info, "releasedate").or_else(|| string(&info, "release_date")),
            rating: rating(&info),
            duration: int(&info, "duration_secs")
                .filter(|s| *s > 0)
                .map(format_runtime)
                .or_else(|| string(&info, "duration")),
            poster: string(&info, "movie_image").or_else(|| string(&info, "cover_big")),
            backdrop: first_url(info.get("backdrop_path")),
            trailer: trailer_url(&info),
        })
    }

    /// Details page data for a series (the `info` part of
    /// `get_series_info`; episodes come from `fetch_episodes`).
    pub async fn series_details(&self, series_id: i64) -> Result<VodDetails> {
        let v = self
            .get_json(Some("get_series_info"), &[("series_id", &series_id.to_string())])
            .await?;
        let info = v.get("info").cloned().unwrap_or(Value::Null);
        Ok(VodDetails {
            plot: string(&info, "plot"),
            genre: string(&info, "genre"),
            cast: string(&info, "cast"),
            director: string(&info, "director"),
            release_date: string(&info, "releaseDate").or_else(|| string(&info, "release_date")),
            rating: rating(&info),
            duration: int(&info, "episode_run_time").filter(|m| *m > 0).map(|m| format!("{} min per episode", m)),
            poster: string(&info, "cover"),
            backdrop: first_url(info.get("backdrop_path")),
            trailer: trailer_url(&info),
        })
    }

    /// Catch-up days per live stream id, for channels the panel archives.
    /// Used to enrich M3U playlists that came from this panel's get.php,
    /// which don't carry the archive flags themselves.
    pub async fn archive_days_by_stream(&self) -> Result<HashMap<i64, i64>> {
        Ok(self
            .get_list("get_live_streams")
            .await?
            .iter()
            .filter_map(|s| Some((int(s, "stream_id")?, archive_days(s)?)))
            .collect())
    }

    /// Seconds to add to the UTC timestamp `at` to get the panel's local
    /// wall clock at that moment — timeshift URLs are expressed in it.
    ///
    /// Uses the panel's configured timezone (server_info.timezone) with a
    /// real tz database, so programmes before a DST switch get the offset
    /// that applied then. `time_now` is not used: load-balanced panels
    /// were seen returning it in local time on one request and in UTC on
    /// the next, while the timezone name stays put.
    pub async fn server_utc_offset(&self, at: i64) -> Result<i64> {
        let v = self.get_json(None, &[]).await?;
        let zone = v.get("server_info").and_then(|i| string(i, "timezone"));
        Ok(utc_offset_in(zone.as_deref(), at))
    }

    /// Timeshift URL for `minutes` of a live stream starting at `start`
    /// (UTC seconds), given the panel's offset from `server_utc_offset`.
    pub fn catchup_url(&self, stream_id: i64, start: i64, minutes: i64, utc_offset: i64) -> Result<String> {
        let local = chrono::DateTime::from_timestamp(start + utc_offset, 0)
            .ok_or_else(|| err!("Invalid catch-up start time"))?
            .naive_utc();
        Ok(format!(
            "{}/timeshift/{}/{}/{}/{}/{}.ts",
            self.host,
            self.username,
            self.password,
            minutes.max(1),
            local.format("%Y-%m-%d:%H-%M"),
            stream_id
        ))
    }
}

/// Offset of IANA zone `zone` from UTC at instant `at`; 0 (UTC) when the
/// zone is missing or unknown, which is also what panels default to.
fn utc_offset_in(zone: Option<&str>, at: i64) -> i64 {
    use chrono::{Offset, TimeZone};
    let Some(tz) = zone.and_then(|z| z.parse::<chrono_tz::Tz>().ok()) else {
        return 0;
    };
    chrono::DateTime::from_timestamp(at, 0)
        .map(|t| tz.offset_from_utc_datetime(&t.naive_utc()).fix().local_minus_utc() as i64)
        .unwrap_or(0)
}

/// Rating out of 10: `rating` when it looks like a 0–10 score, else
/// `rating_5based` doubled. Zero means "unrated" on most panels.
fn rating(v: &Value) -> Option<f64> {
    let num = |key: &str| match v.get(key)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    num("rating")
        .filter(|r| *r > 0.0 && *r <= 10.0)
        .or_else(|| num("rating_5based").filter(|r| *r > 0.0 && *r <= 5.0).map(|r| r * 2.0))
        .map(|r| (r * 10.0).round() / 10.0)
}

/// `backdrop_path` arrives as a JSON array, a single URL, or a Python-style
/// list printed into a string (`"['https://…']"`) depending on the panel.
fn first_url(v: Option<&Value>) -> Option<String> {
    let text = match v? {
        Value::Array(items) => return items.iter().find_map(|i| i.as_str()).map(str::to_string).filter(|s| s.starts_with("http")),
        Value::String(s) => s.as_str(),
        _ => return None,
    };
    let start = text.find("http")?;
    let rest = &text[start..];
    let end = rest.find(|c: char| c == '\'' || c == '"' || c == ',' || c == ']' || c.is_whitespace()).unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

fn trailer_url(info: &Value) -> Option<String> {
    let t = string(info, "youtube_trailer")?;
    Some(if t.starts_with("http") { t } else { format!("https://www.youtube.com/watch?v={}", t) })
}

fn format_runtime(secs: i64) -> String {
    let (h, m) = (secs / 3600, (secs % 3600) / 60);
    if h > 0 { format!("{}h {}m", h, m) } else { format!("{} min", m) }
}

/// `tv_archive_duration` days when `tv_archive` is on.
fn archive_days(s: &Value) -> Option<i64> {
    (int(s, "tv_archive") == Some(1))
        .then(|| int(s, "tv_archive_duration"))
        .flatten()
        .filter(|d| *d > 0)
}

/// Accept what users paste: `host:port`, `http://host:port/`, or a full
/// `…/player_api.php` / `…/get.php?…` URL. Returns `scheme://host[:port]`.
fn normalize_host(input: &str) -> Result<String> {
    let input = input.trim();
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        format!("http://{}", input)
    };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| err!("Invalid Xtream host URL"))?;
    let host = url.host_str().ok_or_else(|| err!("Invalid Xtream host URL"))?;
    Ok(match url.port() {
        Some(p) => format!("{}://{}:{}", url.scheme(), host, p),
        None => format!("{}://{}", url.scheme(), host),
    })
}

/// Recognise an Xtream "M3U plus" link (`…/get.php?username=…&password=…`)
/// so a user who pastes one into the M3U tab gets the much richer Xtream
/// import instead. Returns `(host, username, password)`.
pub fn credentials_from_m3u_url(url: &str) -> Option<(String, String, String)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if !parsed.path().ends_with("/get.php") {
        return None;
    }
    let q: HashMap<_, _> = parsed.query_pairs().collect();
    let user = q.get("username")?.to_string();
    let pass = q.get("password")?.to_string();
    Some((normalize_host(url).ok()?, user, pass))
}

/// The identity of an Xtream stream, extracted from its URL.
/// Pattern: `{scheme}://{host}[:port]/{movie|series|live}/{user}/{pass}/{id}[.{ext}]`.
pub struct XtreamUrl {
    /// "movie" | "series" | "live". Part of a channel's stable identity
    /// across refreshes (see `db::channel_key`).
    pub kind: String,
    pub stream_id: i64,
}

/// Parse an Xtream-formatted stream URL. Returns `None` for anything that
/// doesn't match the expected shape — e.g. generic M3U streams from non-Xtream
/// providers.
pub fn parse_xtream_url(url: &str) -> Option<XtreamUrl> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let segments: Vec<&str> = parsed.path_segments()?.collect();
    let (kind, id_with_ext) = match segments.as_slice() {
        [kind @ ("movie" | "series" | "live"), _user, _pass, id] => (kind.to_string(), *id),
        // Many panels also serve live TV at the short form
        // `/{user}/{pass}/{id}` — no kind segment.
        [_user, _pass, id] => ("live".to_string(), *id),
        _ => return None,
    };
    Some(XtreamUrl { kind, stream_id: parse_stream_id(id_with_ext)? })
}

/// `"123"` or `"123.ts"` → 123.
fn parse_stream_id(segment: &str) -> Option<i64> {
    segment.rsplit_once('.').map(|(a, _)| a).unwrap_or(segment).parse().ok()
}

/// Indexes of the username and password path segments in an Xtream stream
/// URL's path, if it has that shape. Used to redact them from logs.
pub fn credential_segments(segments: &[&str]) -> Option<(usize, usize)> {
    match segments {
        ["movie" | "series" | "live", _, _, id] if parse_stream_id(id).is_some() => Some((1, 2)),
        // Catch-up: /timeshift/{user}/{pass}/{minutes}/{start}/{id}.ts
        ["timeshift", _, _, _, _, id] if parse_stream_id(id).is_some() => Some((1, 2)),
        [_, _, id] if parse_stream_id(id).is_some() => Some((0, 1)),
        _ => None,
    }
}

// ---------- tolerant JSON access ----------

fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// A non-empty, cleaned string — numbers are stringified, since panels
/// send ids either way.
fn string(v: &Value, key: &str) -> Option<String> {
    let raw = match v.get(key)? {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let cleaned = crate::sources::m3u::clean(&raw);
    (!cleaned.is_empty()).then_some(cleaned)
}

/// `user_info` → AccountInfo. Panels send numbers as strings or numbers,
/// and "null" / 0 for accounts without an expiry.
pub fn account_from(info: &Value) -> AccountInfo {
    AccountInfo {
        status: string(info, "status"),
        expires_at: int(info, "exp_date").filter(|t| *t > 0),
        is_trial: int(info, "is_trial") == Some(1),
        active_connections: int(info, "active_cons"),
        max_connections: int(info, "max_connections"),
        created_at: int(info, "created_at").filter(|t| *t > 0),
    }
}

fn int(v: &Value, key: &str) -> Option<i64> {
    match v.get(key)? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn account_details() {
        let v = json!({ "status": "Active", "exp_date": "1798761600", "is_trial": "0",
                        "active_cons": "1", "max_connections": "2", "created_at": 1700000000 });
        let a = account_from(&v);
        assert_eq!(a.status.as_deref(), Some("Active"));
        assert_eq!(a.expires_at, Some(1798761600));
        assert!(!a.is_trial);
        assert_eq!((a.active_connections, a.max_connections), (Some(1), Some(2)));
        let a = account_from(&json!({ "exp_date": null, "is_trial": 1 }));
        assert_eq!(a.expires_at, None);
        assert!(a.is_trial);
    }

    #[test]
    fn tolerant_field_access() {
        let v = json!({ "a": 5, "b": "7", "c": " x\u{200B} ", "d": "", "e": null });
        assert_eq!(int(&v, "a"), Some(5));
        assert_eq!(int(&v, "b"), Some(7));
        assert_eq!(string(&v, "a").as_deref(), Some("5"));
        assert_eq!(string(&v, "c").as_deref(), Some("x"));
        assert_eq!(string(&v, "d"), None);
        assert_eq!(string(&v, "e"), None);
    }

    #[test]
    fn builds_catchup_urls_in_server_time() {
        let x = Xtream::new("http://h:8080", "u", "p", reqwest::Client::new()).unwrap();
        // 2026-10-03 12:30:00 UTC, panel two hours ahead (CEST).
        let url = x.catchup_url(42, 1_791_030_600, 60, 7200).unwrap();
        assert_eq!(url, "http://h:8080/timeshift/u/p/60/2026-10-03:14-30/42.ts");
        assert_eq!(archive_days(&json!({"tv_archive": "1", "tv_archive_duration": "3"})), Some(3));
        assert_eq!(archive_days(&json!({"tv_archive": 0, "tv_archive_duration": "3"})), None);
    }

    #[test]
    fn server_offsets_follow_dst() {
        // 2026-07-01 12:00 UTC: CEST (+2h). 2026-12-01 12:00 UTC: CET (+1h).
        assert_eq!(utc_offset_in(Some("Europe/Stockholm"), 1_782_907_200), 7200);
        assert_eq!(utc_offset_in(Some("Europe/Stockholm"), 1_796_126_400), 3600);
        assert_eq!(utc_offset_in(Some("Not/AZone"), 1_782_907_200), 0);
        assert_eq!(utc_offset_in(None, 1_782_907_200), 0);
    }

    #[test]
    fn reads_library_metadata() {
        assert_eq!(rating(&json!({"rating": "7.145"})), Some(7.1));
        assert_eq!(rating(&json!({"rating": "0", "rating_5based": 3.5})), Some(7.0));
        assert_eq!(rating(&json!({"rating": ""})), None);
        assert_eq!(
            first_url(Some(&json!("['https://image.tmdb.org/t/p/w1280/a.jpg']"))).as_deref(),
            Some("https://image.tmdb.org/t/p/w1280/a.jpg")
        );
        assert_eq!(first_url(Some(&json!(["https://x/b.jpg"]))).as_deref(), Some("https://x/b.jpg"));
        assert_eq!(first_url(Some(&json!(""))), None);
        assert_eq!(format_runtime(3968), "1h 6m");
        assert_eq!(
            trailer_url(&json!({"youtube_trailer": "yKOeF8v67OI"})).as_deref(),
            Some("https://www.youtube.com/watch?v=yKOeF8v67OI")
        );
    }

    #[test]
    fn normalizes_pasted_hosts() {
        assert_eq!(normalize_host("iptv.example.com:8080").unwrap(), "http://iptv.example.com:8080");
        assert_eq!(normalize_host("https://h.tv/player_api.php?x=1").unwrap(), "https://h.tv");
    }

    #[test]
    fn detects_xtream_m3u_links() {
        let (host, u, p) =
            credentials_from_m3u_url("http://h.tv:8080/get.php?username=al&password=pw&type=m3u_plus").unwrap();
        assert_eq!((host.as_str(), u.as_str(), p.as_str()), ("http://h.tv:8080", "al", "pw"));
        assert!(credentials_from_m3u_url("http://h.tv/playlist.m3u").is_none());
    }

    #[test]
    fn parses_stream_urls() {
        let x = parse_xtream_url("http://h:81/movie/u/p/42.mkv").unwrap();
        assert_eq!((x.kind.as_str(), x.stream_id), ("movie", 42));
        assert_eq!(parse_xtream_url("http://h/series/u/p/7").unwrap().stream_id, 7);
        assert!(parse_xtream_url("http://h/other/u/p/7").is_none());
        let short = parse_xtream_url("http://h:2095/u/p/24639").unwrap();
        assert_eq!((short.kind.as_str(), short.stream_id), ("live", 24639));
    }
}
