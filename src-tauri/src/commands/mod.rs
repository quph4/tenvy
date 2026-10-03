pub mod mpv_state;

use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use crate::db::{self, Db};
use crate::err;
use crate::error::Result;
use crate::models::{
    AddSourceReq, Channel, Group, HistoryEntry, HistoryProgress, PlaylistProgress, Programme,
    Source, SourceKind,
};
use crate::sources::xtream::{self, Xtream};
use crate::sources::{m3u, xmltv};

// Everything that lives on the Tauri app as state.
pub struct AppState {
    pub db: Db,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            http: reqwest::Client::builder()
                .user_agent(concat!("Tenvy/", env!("CARGO_PKG_VERSION")))
                // No overall timeout: big playlists and XMLTV files on slow
                // links legitimately take minutes. Instead give up on a
                // dead connection or a stalled transfer.
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(60))
                .build()
                .expect("http client"),
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
    let AddSourceReq { mut kind, name, mut url, mut username, mut password } = req;

    // An Xtream "M3U plus" link pasted into the M3U tab: import it through
    // the Xtream API instead, which adds series, cleaner categories and
    // the provider's guide.
    if matches!(kind, SourceKind::M3u) {
        if let Some((host, u, p)) = xtream::credentials_from_m3u_url(&url) {
            kind = SourceKind::Xtream;
            url = host;
            username = Some(u);
            password = Some(p);
        }
    }

    // Insert the row first so we have an id to refresh under.
    let db = state.db.clone();
    let id = tokio::task::spawn_blocking(move || {
        db::insert_source(&db, &kind, &name, &url, username.as_deref(), password.as_deref())
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
    let (mut channels, guide_url) = tokio::task::spawn_blocking(move || {
        let guide = m3u::header_guide_url(&body);
        m3u::parse(&body).map(|c| (c, guide))
    })
    .await??;

    // An Xtream get.php playlist doesn't say which channels have catch-up;
    // the panel's API does. Best effort — a failure only costs catch-up.
    if let Some((host, user, pass)) = xtream::credentials_from_m3u_url(&source.url) {
        match Xtream::new(&host, &user, &pass, state.http.clone()) {
            Ok(xt) => match xt.archive_days_by_stream().await {
                Ok(archive) => {
                    for c in channels.iter_mut().filter(|c| c.kind == "live") {
                        if let Some(x) = xtream::parse_xtream_url(&c.stream_url) {
                            c.archive_days = archive.get(&x.stream_id).copied();
                        }
                    }
                }
                Err(e) => tracing::warn!(target: "tenvy_lib", "catch-up info unavailable: {}", e),
            },
            Err(e) => tracing::warn!(target: "tenvy_lib", "catch-up info unavailable: {}", e),
        }
    }

    let count = channels.len() as i64;
    emit_progress(app, source.id, "storing", count);
    let db = state.db.clone();
    let sid = source.id;
    tokio::task::spawn_blocking(move || db::replace_channels(&db, sid, db::ALL_KINDS, &channels)).await??;

    // `#EXTM3U url-tvg="…"` names the playlist's own guide. Failing that,
    // an Xtream `get.php` playlist has the panel's guide at `xmltv.php`.
    let guide_url = guide_url.or_else(|| {
        let (host, user, pass) = xtream::credentials_from_m3u_url(&source.url)?;
        Xtream::new(&host, &user, &pass, state.http.clone()).ok().map(|x| x.xmltv_url())
    });
    if let Some(url) = guide_url {
        refresh_guide_in_background(app.clone(), state.db.clone(), state.http.clone(), url, sid);
    }
    Ok(())
}

async fn ingest_xtream(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source: &Source,
    username: &str,
    password: &str,
) -> Result<()> {
    let xt = Xtream::new(&source.url, username, password, state.http.clone())?;
    let catalogue = xt.fetch_catalogue().await?;
    tracing::info!(
        target: "tenvy_lib",
        "xtream catalogue: {} live, {} movies, {} series",
        catalogue.live, catalogue.movies, catalogue.series
    );
    emit_progress(app, source.id, "storing", catalogue.channels.len() as i64);
    let db = state.db.clone();
    let sid = source.id;
    tokio::task::spawn_blocking(move || {
        db::replace_channels(&db, sid, &catalogue.kinds, &catalogue.channels)
    })
    .await??;

    // The provider's guide can be tens of MB; don't hold the UI for it.
    refresh_guide_in_background(app.clone(), state.db.clone(), state.http.clone(), xt.xmltv_url(), sid);
    Ok(())
}

async fn ingest_xmltv(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source: &Source,
) -> Result<()> {
    let bytes = fetch_bytes(&state.http, &source.url).await?;
    emit_progress(app, source.id, "parsing", 0);
    let guide = tokio::task::spawn_blocking(move || xmltv::parse(&bytes)).await??;
    emit_progress(app, source.id, "storing", guide.programmes.len() as i64);
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::upsert_guide(&db, &guide)).await??;
    Ok(())
}

/// Download and store a guide without blocking the caller. Emits
/// `guide-updated` (with the source id) when new programmes are in. A
/// failure only costs guide data, so it's logged rather than surfaced.
fn refresh_guide_in_background(app: AppHandle, db: Db, http: reqwest::Client, url: String, source_id: i64) {
    tokio::spawn(async move {
        let result: Result<usize> = async {
            let bytes = fetch_bytes(&http, &url).await?;
            let guide = tokio::task::spawn_blocking(move || xmltv::parse(&bytes)).await??;
            tokio::task::spawn_blocking(move || db::upsert_guide(&db, &guide)).await?
        }
        .await;
        match result {
            Ok(n) => {
                tracing::info!(target: "tenvy_lib", "guide for source {}: {} programmes", source_id, n);
                let _ = app.emit("guide-updated", source_id);
            }
            Err(e) => tracing::warn!(
                target: "tenvy_lib",
                "guide for source {} ({}) failed: {}",
                source_id,
                crate::sources::stream_url::redact(&url),
                e
            ),
        }
    });
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String> {
    let bytes = fetch_bytes(client, url).await?;
    // Tolerate the odd Latin-1 byte rather than rejecting a whole playlist.
    Ok(String::from_utf8(bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

/// Fetch a remote URL, or read a local file for anything that isn't
/// http(s) — users can point a source at a playlist on disk.
async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        let path = url.strip_prefix("file://").unwrap_or(url);
        return Ok(tokio::fs::read(path).await?);
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

/// The Xtream panel behind a source, if any: an Xtream source, or an M3U
/// playlist downloaded from a panel's get.php.
pub(crate) async fn xtream_for_source(state: &AppState, source_id: i64) -> Result<Option<Xtream>> {
    let db = state.db.clone();
    let (source, user, pass) =
        tokio::task::spawn_blocking(move || db::get_source_credentials(&db, source_id)).await??;
    let creds = match source.kind {
        SourceKind::Xtream => Some((source.url, user.unwrap_or_default(), pass.unwrap_or_default())),
        _ => xtream::credentials_from_m3u_url(&source.url),
    };
    creds
        .map(|(host, user, pass)| Xtream::new(&host, &user, &pass, state.http.clone()))
        .transpose()
}

/// Timeshift URL for a past (or ongoing) programme on a channel with
/// catch-up. `start`/`stop` are UTC seconds from the guide.
pub(crate) async fn catchup_url(state: &AppState, channel_id: i64, start: i64, stop: i64) -> Result<String> {
    let db = state.db.clone();
    let channel = tokio::task::spawn_blocking(move || db::get_channel(&db, channel_id))
        .await??
        .ok_or_else(|| err!("Channel not found"))?;
    let days = channel
        .archive_days
        .ok_or_else(|| err!("{} has no catch-up.", channel.name))?;
    let now = chrono::Utc::now().timestamp();
    if start >= now {
        return Err(err!("That programme hasn't started yet."));
    }
    if start < now - days * 86_400 {
        return Err(err!("The provider only keeps {} day(s) of {}.", days, channel.name));
    }
    let stream_id = xtream::parse_xtream_url(&channel.stream_url)
        .ok_or_else(|| err!("Catch-up needs an Xtream Codes stream."))?
        .stream_id;
    let xt = xtream_for_source(state, channel.source_id)
        .await?
        .ok_or_else(|| err!("Catch-up needs an Xtream Codes provider."))?;
    let offset = xt.server_utc_offset(start).await?;
    let minutes = (stop.max(start + 60) - start + 59) / 60;
    xt.catchup_url(stream_id, start, minutes, offset)
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
    source_id: Option<i64>,
    kind: Option<String>,
) -> Result<Vec<Channel>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        db::search_channels(&db, &query, source_id, kind.as_deref())
    })
    .await?
}

/// Episodes of a series container. Fetched fresh from the provider each
/// time (one request) and synced into the DB so episode ids — and their
/// history — stay stable; falls back to the stored list when offline.
#[tauri::command]
pub async fn list_episodes(state: State<'_, AppState>, channel_id: i64) -> Result<Vec<Channel>> {
    let db = state.db.clone();
    let show = tokio::task::spawn_blocking(move || db::get_channel(&db, channel_id))
        .await??
        .ok_or_else(|| err!("Series not found"))?;
    if !show.container {
        return Err(err!("{} is not a series", show.name));
    }

    let fetched: Result<Vec<db::ChannelInsert>> = async {
        let series_id = xtream::parse_xtream_url(&show.stream_url)
            .ok_or_else(|| err!("Series has no Xtream id"))?
            .stream_id;
        let db = state.db.clone();
        let sid = show.source_id;
        let (source, user, pass) =
            tokio::task::spawn_blocking(move || db::get_source_credentials(&db, sid)).await??;
        let xt = Xtream::new(
            &source.url,
            user.as_deref().unwrap_or(""),
            pass.as_deref().unwrap_or(""),
            state.http.clone(),
        )?;
        xt.fetch_episodes(series_id).await
    }
    .await;

    let db = state.db.clone();
    match fetched {
        Ok(eps) => tokio::task::spawn_blocking(move || db::replace_episodes(&db, channel_id, &eps)).await?,
        Err(e) => {
            let cached = tokio::task::spawn_blocking(move || db::list_episodes(&db, channel_id)).await??;
            if cached.is_empty() {
                Err(e)
            } else {
                tracing::warn!(target: "tenvy_lib", "episodes for {} served from cache: {}", channel_id, e);
                Ok(cached)
            }
        }
    }
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

/// What's on now for a batch of guide ids — one call per screen of rows.
#[tauri::command]
pub async fn now_playing(
    state: State<'_, AppState>,
    tvg_ids: Vec<String>,
) -> Result<Vec<Programme>> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db::now_playing(&db, &tvg_ids)).await?
}

// ---------- external player ----------

/// Hand a stream URL to a locally-installed external player (mpv preferred,
/// then VLC) — the escape hatch when the user wants a standalone window.
///
/// Returns the path of the player that was launched so we can report it
/// back to the user.
#[tauri::command]
pub async fn open_external(
    app: AppHandle,
    state: State<'_, AppState>,
    channel_id: i64,
    audio_track: Option<i64>,
    subtitle_track: Option<i64>,
) -> Result<String> {
    use tauri::Manager;
    let db = state.db.clone();
    let playback = tokio::task::spawn_blocking(move || db::get_playback(&db, channel_id))
        .await??
        .ok_or_else(|| err!("Channel not found"))?;
    let url = playback.stream_url;
    // The URL comes from a provider's playlist. Validation guarantees it's
    // a network URL (so it can't be read as a `--option`), and mpv also
    // gets an explicit `--` before it.
    crate::sources::stream_url::validate(&url)?;
    // Prefer the mpv we ship; it opens in its own window just fine.
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("mpv").join("mpv.exe"))
        .filter(|p| p.is_file());
    tokio::task::spawn_blocking(move || -> Result<String> {
        let (player, is_mpv) = match bundled.or_else(crate::players::find_system_mpv) {
            Some(p) => (p, true),
            None => (
                crate::players::find_vlc().ok_or_else(|| {
                    err!("No external player found. Install mpv (https://mpv.io) or VLC and try again.")
                })?,
                false,
            ),
        };

        // Track ids are mpv's aid/sid: 1-based within each track type.
        let mut cmd = std::process::Command::new(&player);
        if is_mpv {
            if let Some(a) = audio_track {
                cmd.arg(format!("--aid={}", a));
            }
            match subtitle_track {
                Some(s) => cmd.arg(format!("--sid={}", s)),
                // Explicit --sid=no so mpv doesn't auto-pick a sub when the
                // user chose "Off" in Tenvy.
                None => cmd.arg("--sid=no"),
            };
            if let Some(ua) = &playback.user_agent {
                cmd.arg(format!("--user-agent={}", ua));
            }
            if let Some(r) = &playback.referrer {
                cmd.arg(format!("--referrer={}", r));
            }
            cmd.arg("--");
        } else {
            if let Some(ua) = &playback.user_agent {
                cmd.arg(format!("--http-user-agent={}", ua));
            }
            if let Some(r) = &playback.referrer {
                cmd.arg(format!("--http-referrer={}", r));
            }
            // VLC's track flags are 0-based indexes within the type.
            if let Some(a) = audio_track {
                cmd.arg(format!("--audio-track={}", a - 1));
            }
            match subtitle_track {
                Some(s) => {
                    cmd.arg(format!("--sub-track={}", s - 1));
                }
                None => {
                    cmd.arg("--no-sub-autodetect-file").arg("--sub-track=-1");
                }
            }
        }
        cmd.arg(&url)
            .spawn()
            .map_err(|e| err!("Failed to launch {}: {}", player.display(), e))?;
        tracing::info!(
            target: "tenvy_lib",
            "launched external player: {} url={} (aid={:?}, sid={:?})",
            player.display(),
            crate::sources::stream_url::redact(&url),
            audio_track,
            subtitle_track
        );
        Ok(player.to_string_lossy().into_owned())
    })
    .await?
}
