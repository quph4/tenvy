use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    M3u,
    Xtream,
    Xmltv,
}

impl SourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceKind::M3u => "m3u",
            SourceKind::Xtream => "xtream",
            SourceKind::Xmltv => "xmltv",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "m3u" => SourceKind::M3u,
            "xtream" => SourceKind::Xtream,
            "xmltv" => SourceKind::Xmltv,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: i64,
    pub kind: SourceKind,
    pub name: String,
    pub url: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: i64,
    pub source_id: i64,
    pub tvg_id: Option<String>,
    pub name: String,
    pub logo: Option<String>,
    pub group: Option<String>,
    pub stream_url: String,
    pub sort_order: i64,
    /// "live" | "movie" | "series"
    pub kind: String,
    /// A series show whose episodes load on demand (`list_episodes`).
    pub container: bool,
    /// Set on episodes: the show (container) they belong to.
    pub parent_id: Option<i64>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// Days of catch-up the provider keeps for this live channel.
    pub archive_days: Option<i64>,
    /// Movies/series: rating out of 10, release year, when it was added.
    pub rating: Option<f64>,
    pub year: Option<i64>,
    pub added: Option<i64>,
}

/// A programme the user asked to be reminded of.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub channel: Channel,
    pub start: i64,
    pub stop: i64,
    pub title: String,
}

/// Top-level item counts for a source.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStats {
    pub live: i64,
    pub movies: i64,
    pub series: i64,
}

/// Everything the library's details page shows for a movie or series.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VodDetails {
    pub plot: Option<String>,
    pub genre: Option<String>,
    pub cast: Option<String>,
    pub director: Option<String>,
    pub release_date: Option<String>,
    /// Out of 10.
    pub rating: Option<f64>,
    /// "1h 52m" style, when the provider knows it.
    pub duration: Option<String>,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    /// Full YouTube URL.
    pub trailer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Programme {
    pub channel_tvg_id: String,
    pub start: i64,
    pub stop: i64,
    pub title: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub name: String,
    pub count: i64,
    /// Hidden by the viewer: left out of lists, "All" and search.
    #[serde(default)]
    pub hidden: bool,
    /// Behind the parental PIN.
    #[serde(default)]
    pub locked: bool,
    /// Locked because its name holds a parental keyword (not a toggle).
    #[serde(default)]
    pub locked_by_word: bool,
}

/// An Xtream account's subscription details (never the password).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    /// "Active", "Expired", "Banned", "Disabled"…
    pub status: Option<String>,
    /// Epoch seconds; None for accounts that never expire.
    pub expires_at: Option<i64>,
    pub is_trial: bool,
    pub active_connections: Option<i64>,
    pub max_connections: Option<i64>,
    pub created_at: Option<i64>,
}

/// Parental lock state for the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentalStatus {
    pub pin_set: bool,
    /// Locked categories are visible right now (no PIN, or unlocked).
    pub unlocked: bool,
}

/// A channel the user has watched, plus the progress we've saved. The
/// frontend uses this for the History list and to draw progress bars /
/// "finished" badges on movie and episode rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub channel: Channel,
    pub time_pos: f64,
    pub duration: f64,
    pub watched_at: i64,
    pub finished: bool,
}

/// Just the progress fields — returned when the player asks "do I have a
/// saved position for this channel?" without needing the full Channel row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryProgress {
    pub channel_id: i64,
    pub time_pos: f64,
    pub duration: f64,
    pub watched_at: i64,
    pub finished: bool,
}

/// Payload for adding a new source from the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSourceReq {
    pub kind: SourceKind,
    pub name: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Progress event emitted while ingesting a playlist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistProgress {
    pub source_id: i64,
    pub stage: String,
    pub count: i64,
}
