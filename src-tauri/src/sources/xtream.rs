use std::collections::HashMap;

use serde_json::Value;

use crate::db::ChannelInsert;
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
                Some(ChannelInsert {
                    name: string(s, "name").unwrap_or_else(|| format!("Movie {}", id)),
                    logo: string(s, "stream_icon").or_else(|| string(s, "cover")),
                    group: string(s, "category_id").and_then(|c| cats.get(&c).cloned()),
                    stream_url: self.stream_url("movie", id, &ext),
                    kind: "movie".into(),
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
                Some(ChannelInsert {
                    name: string(s, "name").unwrap_or_else(|| format!("Series {}", id)),
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
