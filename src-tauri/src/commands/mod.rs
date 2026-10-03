pub mod mpv_state;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{self, Db};
use crate::error::Result;
use crate::models::{
    AddSourceReq, Channel, Group, HistoryEntry, HistoryProgress, PlaylistProgress, Programme,
    Source, SourceKind,
};
use crate::sources::xtream::{parse_xtream_url, ProbedTracks, Xtream};
use crate::sources::{container, m3u, xmltv};
use crate::err;

// Everything that lives on the Tauri app as state.
pub struct AppState {
    pub db: Db,
    pub http: reqwest::Client,
    /// `get_vod_info` responses keyed by channel id. Probing hits the
    /// provider with an HTTP roundtrip, and users flip between movies/
    /// episodes fast — caching for a few minutes keeps the picker snappy
    /// without serving truly stale data (track layout doesn't change).
    pub probe_cache: Mutex<HashMap<i64, CachedProbe>>,
}

pub struct CachedProbe {
    pub at: Instant,
    pub tracks: ProbedTracks,
}

const PROBE_TTL: Duration = Duration::from_secs(600);

impl AppState {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            http: reqwest::Client::builder()
                .user_agent("Lumen/0.1")
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("http client"),
            probe_cache: Mutex::new(HashMap::new()),
        }
    }
}

// ---------- sources ----------

#[tauri::command]
pub async fn list_sources(state: State<'_, AppState>) -> Result<Vec<Source>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::list_sources(&db)).await?
}

#[tauri::command]
pub async fn add_source(
    app: AppHandle,
    state: State<'_, AppState>,
    req: AddSourceReq,
) -> Result<Source> {
    // Insert the row first so we have an id to refresh under.
    let db = state.db.clone();
    let kind = req.kind.clone();
    let name = req.name.clone();
    let url = req.url.clone();
    let username = req.username.clone();
    let password = req.password.clone();

    let id = tokio::task::spawn_blocking({
        let db = db.clone();
        move || {
            db::insert_source(
                &db,
                &kind,
                &name,
                &url,
                username.as_deref(),
                password.as_deref(),
            )
        }
    })
    .await??;

    // Populate channels / programmes immediately.
    if let Err(e) = ingest(&app, &state, id).await {
        // Roll back the source row so the user can retry cleanly.
        let db = state.db.clone();
        let _ = tokio::task::spawn_blocking(move || db::delete_source(&db, id)).await;
        return Err(e);
    }

    let db = state.db.clone();
    let src = tokio::task::spawn_blocking(move || db::get_source(&db, id)).await??;
    src.ok_or_else(|| err!("Source vanished after insert"))
}

#[tauri::command]
pub async fn refresh_source(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<()> {
    ingest(&app, &state, id).await
}

#[tauri::command]
pub async fn remove_source(state: State<'_, AppState>, id: i64) -> Result<()> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::delete_source(&db, id)).await?
}

async fn ingest(app: &AppHandle, state: &State<'_, AppState>, id: i64) -> Result<()> {
    let db = state.db.clone();
    let (source, username, password) =
        tokio::task::spawn_blocking(move || db::get_source_credentials(&db, id)).await??;

    emit_progress(app, id, "fetching", 0);

    match source.kind {
        SourceKind::M3u => ingest_m3u(app, state, &source).await?,
        SourceKind::Xtream => {
            ingest_xtream(
                app,
                state,
                &source,
                username.as_deref().unwrap_or(""),
                password.as_deref().unwrap_or(""),
            )
            .await?
        }
        SourceKind::Xmltv => ingest_xmltv(app, state, &source).await?,
    }

    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::touch_source(&db, id)).await??;

    emit_progress(app, id, "done", 0);
    Ok(())
}

async fn ingest_m3u(app: &AppHandle, state: &State<'_, AppState>, source: &Source) -> Result<()> {
    let body = fetch_text(&state.http, &source.url).await?;
    emit_progress(app, source.id, "parsing", 0);
    let channels = tokio::task::spawn_blocking(move || m3u::parse(&body)).await??;
    let count = channels.len() as i64;
    emit_progress(app, source.id, "storing", count);
    let db = state.db.clone();
    let sid = source.id;
    tokio::task::spawn_blocking(move || db::replace_channels(&db, sid, &channels)).await??;
    Ok(())
}

async fn ingest_xtream(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source: &Source,
    username: &str,
    password: &str,
) -> Result<()> {
    let xt = Xtream::new(&source.url, username, password)?;
    let channels = xt.fetch_channels().await?;
    let count = channels.len() as i64;
    emit_progress(app, source.id, "storing", count);
    let db = state.db.clone();
    let sid = source.id;
    tokio::task::spawn_blocking(move || db::replace_channels(&db, sid, &channels)).await??;
    Ok(())
}

async fn ingest_xmltv(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source: &Source,
) -> Result<()> {
    let bytes = fetch_bytes(&state.http, &source.url).await?;
    emit_progress(app, source.id, "parsing", 0);
    let programmes = tokio::task::spawn_blocking(move || xmltv::parse(&bytes)).await??;
    let count = programmes.len() as i64;
    emit_progress(app, source.id, "storing", count);
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::upsert_programmes(&db, &programmes)).await??;
    Ok(())
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String> {
    if let Some(path) = url.strip_prefix("file://").or_else(|| {
        // Treat non-http paths as local files (Windows-friendly)
        if url.starts_with("http://") || url.starts_with("https://") {
            None
        } else {
            Some(url)
        }
    }) {
        let bytes = tokio::fs::read(path).await?;
        return String::from_utf8(bytes).map_err(|e| err!("Invalid UTF-8 in playlist: {}", e));
    }
    let resp = client.get(url).send().await?.error_for_status()?;
    Ok(resp.text().await?)
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        let path = url.strip_prefix("file://").unwrap_or(url);
        let bytes = tokio::fs::read(path).await?;
        return Ok(bytes);
    }
    let resp = client.get(url).send().await?.error_for_status()?;
    Ok(resp.bytes().await?.to_vec())
}

fn emit_progress(app: &AppHandle, source_id: i64, stage: &str, count: i64) {
    let _ = app.emit(
        "playlist-progress",
        PlaylistProgress {
            source_id,
            stage: stage.to_string(),
            count,
        },
    );
}

// ---------- channels ----------

#[tauri::command]
pub async fn list_groups(
    state: State<'_, AppState>,
    source_id: Option<i64>,
    kind: Option<String>,
) -> Result<Vec<Group>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::list_groups(&db, source_id, kind.as_deref())).await?
}

#[tauri::command]
pub async fn list_channels(
    state: State<'_, AppState>,
    source_id: Option<i64>,
    group: Option<String>,
    kind: Option<String>,
) -> Result<Vec<Channel>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        db::list_channels(&db, source_id, group.as_deref(), kind.as_deref())
    })
    .await?
}

#[tauri::command]
pub async fn search_channels(
    state: State<'_, AppState>,
    query: String,
    kind: Option<String>,
) -> Result<Vec<Channel>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::search_channels(&db, &query, kind.as_deref())).await?
}

// ---------- track probe ----------

/// Ask the provider what audio/subtitle tracks live inside a VOD file.
///
/// WebView2 can't enumerate alternate tracks for out-of-tree MKV containers,
/// so the baseline `<video>.audioTracks` is always a single "Default" entry.
/// Xtream panels, however, stash the ffprobe output of every movie in their
/// `get_vod_info` endpoint — pulling that lets the picker display the real
/// track list even though we still can't switch them in-app (mpv/VLC via
/// the X key is the switch path).
///
/// Returns empty arrays for non-Xtream URLs or when the panel 404s the vod
/// id — the frontend treats that the same as "no extras known."
#[tauri::command]
pub async fn probe_tracks(
    state: State<'_, AppState>,
    channel_id: i64,
) -> Result<ProbedTracks> {
    // Cache hit → don't hammer the panel every time the user reopens the
    // picker on the same movie.
    if let Some(hit) = state.probe_cache.lock().unwrap().get(&channel_id) {
        if hit.at.elapsed() < PROBE_TTL {
            return Ok(hit.tracks.clone());
        }
    }

    let db = state.db.clone();
    let channel = tokio::task::spawn_blocking(move || db::get_channel(&db, channel_id))
        .await??
        .ok_or_else(|| err!("channel {} not found", channel_id))?;

    // Only VOD probes are meaningful — live streams don't have a static
    // container to enumerate.
    if channel.kind != "movie" && channel.kind != "series" {
        return Ok(ProbedTracks {
            provider: "none".into(),
            ..Default::default()
        });
    }

    // Xtream `get_vod_info` (when this is an Xtream URL) — cheap metadata
    // call that's often wrong: standard panels only report the default audio
    // track and no subtitles. We use it as a hint, then fall through to a
    // direct container probe when it's obviously incomplete.
    let xtream_tracks = if let Some(parsed) = parse_xtream_url(&channel.stream_url) {
        match Xtream::new(&parsed.host, &parsed.username, &parsed.password) {
            Ok(xt) => xt.probe_vod(parsed.stream_id).await.unwrap_or_else(|e| {
                tracing::warn!(target: "lumen_lib", "probe_vod failed for channel {}: {}", channel_id, e);
                ProbedTracks { provider: "xtream".into(), ..Default::default() }
            }),
            Err(_) => ProbedTracks::default(),
        }
    } else {
        ProbedTracks::default()
    };

    // Container probe: range-GET the file and demux the track list. This is
    // the authoritative source — ffprobe-equivalent — for everything the
    // Xtream panel hides (additional audio tracks, subtitles, commentary).
    // Costs a few MB of bandwidth per movie, cached for 10 minutes.
    let container_tracks = container::probe_url(&state.http, &channel.stream_url)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(target: "lumen_lib", "container probe failed for channel {}: {}", channel_id, e);
            ProbedTracks::default()
        });

    // Prefer whichever source found more tracks. Container probe wins ties
    // because it sees the real file; Xtream wins only when the container
    // probe came back empty (range requests blocked, unknown format).
    let container_total = container_tracks.audio.len() + container_tracks.subtitle.len();
    let xtream_total = xtream_tracks.audio.len() + xtream_tracks.subtitle.len();
    let tracks = if container_total >= xtream_total && container_total > 0 {
        container_tracks
    } else if xtream_total > 0 {
        xtream_tracks
    } else {
        // Nothing worked — surface the container probe's empty result so the
        // UI can still show "no extra tracks" without a confusing "xtream"
        // provider tag when the URL wasn't even Xtream.
        ProbedTracks { provider: "none".into(), ..Default::default() }
    };

    state.probe_cache.lock().unwrap().insert(
        channel_id,
        CachedProbe {
            at: Instant::now(),
            tracks: tracks.clone(),
        },
    );
    Ok(tracks)
}

// ---------- favorites ----------

#[tauri::command]
pub async fn list_favorites(state: State<'_, AppState>) -> Result<Vec<Channel>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::list_favorites(&db)).await?
}

#[tauri::command]
pub async fn toggle_favorite(state: State<'_, AppState>, channel_id: i64) -> Result<bool> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::toggle_favorite(&db, channel_id)).await?
}

// ---------- watch history ----------

#[tauri::command]
pub async fn record_history(
    state: State<'_, AppState>,
    channel_id: i64,
    time_pos: f64,
    duration: f64,
    finished: bool,
) -> Result<()> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        db::upsert_watch_progress(&db, channel_id, time_pos, duration, finished)
    })
    .await?
}

#[tauri::command]
pub async fn list_history(state: State<'_, AppState>) -> Result<Vec<HistoryEntry>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::list_watch_history(&db)).await?
}

#[tauri::command]
pub async fn list_history_progress(
    state: State<'_, AppState>,
) -> Result<Vec<HistoryProgress>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::list_history_progress(&db)).await?
}

#[tauri::command]
pub async fn get_history_entry(
    state: State<'_, AppState>,
    channel_id: i64,
) -> Result<Option<HistoryProgress>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::get_watch_entry(&db, channel_id)).await?
}

#[tauri::command]
pub async fn remove_history_entry(
    state: State<'_, AppState>,
    channel_id: i64,
) -> Result<()> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::remove_watch_entry(&db, channel_id)).await?
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> Result<()> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::clear_watch_history(&db)).await?
}

// ---------- programmes ----------

#[tauri::command]
pub async fn programmes_for_channels(
    state: State<'_, AppState>,
    tvg_ids: Vec<String>,
    from: i64,
    to: i64,
) -> Result<Vec<Programme>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::programmes_for_channels(&db, &tvg_ids, from, to))
        .await?
}

#[tauri::command]
pub async fn current_programme(
    state: State<'_, AppState>,
    tvg_id: String,
) -> Result<Option<Programme>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::current_programme(&db, &tvg_id)).await?
}

// ---------- external player ----------

/// Hand a stream URL to a locally-installed external player (mpv preferred,
/// then VLC). This is the escape hatch for streams WebView2 can't decode
/// — HEVC/H.265 video, AC-3/EAC-3 audio, and the like.
///
/// Returns the path of the player that was launched so we can report it
/// back to the user.
#[tauri::command]
pub async fn open_external(
    url: String,
    audio_track: Option<i64>,
    subtitle_track: Option<i64>,
) -> Result<String> {
    tokio::task::spawn_blocking(move || -> Result<String> {
        let player = find_external_player().ok_or_else(|| {
            err!("No external player found. Install mpv (https://mpv.io) or VLC and try again.")
        })?;

        // mpv and VLC both take the same MKV track number we collected
        // from the container probe, just via different flags. Choose by
        // executable name so a user's preferred player gets the right
        // argument shape.
        let is_mpv = player.to_lowercase().contains("mpv");
        let mut cmd = std::process::Command::new(&player);
        if is_mpv {
            if let Some(a) = audio_track {
                cmd.arg(format!("--aid={}", a));
            }
            if let Some(s) = subtitle_track {
                cmd.arg(format!("--sid={}", s));
            } else {
                // Explicit --sid=no so mpv doesn't auto-pick a sub when
                // the user chose "Off" in Lumen.
                cmd.arg("--sid=no");
            }
        } else {
            // VLC. Its track-id flags are 1-based and line up with the
            // MKV TrackNumber we pass through.
            if let Some(a) = audio_track {
                cmd.arg(format!("--audio-track={}", a));
            }
            if let Some(s) = subtitle_track {
                cmd.arg(format!("--sub-track={}", s));
            } else {
                cmd.arg("--no-sub-autodetect-file");
                cmd.arg("--sub-track=-1");
            }
        }
        cmd.arg(&url)
            .spawn()
            .map_err(|e| err!("Failed to launch {}: {}", player, e))?;
        tracing::info!(
            target: "lumen_lib",
            "launched external player: {} (aid={:?}, sid={:?})",
            player, audio_track, subtitle_track
        );
        Ok(player)
    })
    .await?
}

fn find_external_player() -> Option<String> {
    // Prefer mpv: lighter, better IPTV handling, fewer UI distractions.
    const DIRECT_CANDIDATES: &[&str] = &[
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files (x86)\mpv\mpv.exe",
        r"C:\Program Files\MPV Player\mpv.exe",
        r"C:\Program Files (x86)\MPV Player\mpv.exe",
        r"C:\Program Files\VideoLAN\VLC\vlc.exe",
        r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
    ];
    for p in DIRECT_CANDIDATES {
        if std::path::Path::new(p).exists() {
            return Some((*p).to_string());
        }
    }
    // Per-user mpv installs sometimes land under APPDATA / LOCALAPPDATA.
    for env_var in ["LOCALAPPDATA", "APPDATA"] {
        if let Ok(base) = std::env::var(env_var) {
            let p = format!(r"{}\mpv\mpv.exe", base);
            if std::path::Path::new(&p).exists() {
                return Some(p);
            }
        }
    }
    // PATH lookup as a final fallback.
    for exe in ["mpv.exe", "vlc.exe"] {
        if let Some(found) = lookup_on_path(exe) {
            return Some(found);
        }
    }
    None
}

fn lookup_on_path(exe: &str) -> Option<String> {
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(';').filter(|d| !d.is_empty()) {
        let full = std::path::Path::new(dir).join(exe);
        if full.exists() {
            return Some(full.to_string_lossy().into_owned());
        }
    }
    None
}

// ---------- diagnostics ----------

// Append a line to %APPDATA%/com.lumen.app/lumen.log. Used by the frontend
// to capture playback failures that only surface inside the webview (hls.js
// fatals, CORS rejections, <video> error codes) so we can actually see them.
#[tauri::command]
pub async fn log_error(app: AppHandle, msg: String) -> Result<()> {
    use std::io::Write;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err!("no app data dir: {}", e))?;
    tokio::task::spawn_blocking(move || -> Result<()> {
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("lumen.log");
        let ts = chrono::Utc::now().to_rfc3339();
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        writeln!(f, "[{ts}] {msg}")?;
        tracing::warn!(target: "lumen_lib", "{}", msg);
        Ok(())
    })
    .await?
}
