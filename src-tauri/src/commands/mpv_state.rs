//! Tauri command surface for the embedded mpv.
//!
//! The frontend lifecycle is:
//! 1. On window ready, call `mpv_init`. We create a child HWND, spawn mpv,
//!    and start forwarding state updates as Tauri events.
//! 2. Frontend calls `mpv_load(url, startSeconds?)` to play.
//! 3. Play/pause/seek/volume/tracks are one-line IPC calls.
//! 4. `mpv_set_geometry` moves the native video rect to match the player
//!    panel — called whenever the React layout reports a resize.
//! 5. mpv is killed with us via a job object (see `mpv::job`).
//!
//! If mpv dies (crash, killed externally) we emit `mpv://event` with
//! `{ kind: "crashed" }`, and the next command transparently respawns it
//! into the same child HWND.
//!
//! Non-Windows builds compile to stubs so the `generate_handler!` macro
//! doesn't need conditional arms.

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use crate::err;
use crate::error::Result;

/// What we store in Tauri app state. The handle is optional because mpv
/// boots lazily — Options avoid forcing every pre-init caller through a
/// "not ready yet" error on otherwise benign channel-list queries.
#[derive(Default)]
pub struct MpvHolder {
    #[cfg(windows)]
    pub inner: Mutex<Option<MpvHandles>>,
    #[cfg(not(windows))]
    pub _priv: Mutex<()>,
}

#[cfg(windows)]
pub struct MpvHandles {
    pub mpv: crate::mpv::Mpv,
    pub child_hwnd: isize,
    /// Last volume/mute the frontend asked for, re-applied on respawn.
    pub audio: crate::mpv::InitialAudio,
}

// ---- commands ----

#[tauri::command]
pub async fn mpv_init(app: AppHandle, holder: State<'_, MpvHolder>) -> Result<()> {
    #[cfg(windows)]
    {
        ensure_mpv(&app, &holder).await?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, holder);
        Err(err!("embedded mpv is only supported on Windows right now"))
    }
}

#[tauri::command]
pub async fn mpv_load(
    app: AppHandle,
    holder: State<'_, MpvHolder>,
    url: String,
    start_seconds: Option<f64>,
) -> Result<()> {
    #[cfg(windows)]
    {
        ensure_mpv(&app, &holder).await?.load(&url, start_seconds).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, holder, url, start_seconds);
        Err(err!("embedded mpv is only supported on Windows right now"))
    }
}

#[tauri::command]
pub async fn mpv_set_pause(app: AppHandle, holder: State<'_, MpvHolder>, paused: bool) -> Result<()> {
    #[cfg(windows)]
    {
        ensure_mpv(&app, &holder).await?.set_pause(paused).await
    }
    #[cfg(not(windows))]
    { let _ = (app, holder, paused); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_seek(app: AppHandle, holder: State<'_, MpvHolder>, seconds: f64) -> Result<()> {
    #[cfg(windows)]
    {
        ensure_mpv(&app, &holder).await?.seek_absolute(seconds).await
    }
    #[cfg(not(windows))]
    { let _ = (app, holder, seconds); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_set_volume(app: AppHandle, holder: State<'_, MpvHolder>, volume: f64) -> Result<()> {
    #[cfg(windows)]
    {
        let mpv = ensure_mpv(&app, &holder).await?;
        if let Some(h) = holder.inner.lock().await.as_mut() {
            h.audio.volume = volume;
        }
        mpv.set_volume(volume).await
    }
    #[cfg(not(windows))]
    { let _ = (app, holder, volume); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_set_muted(app: AppHandle, holder: State<'_, MpvHolder>, muted: bool) -> Result<()> {
    #[cfg(windows)]
    {
        let mpv = ensure_mpv(&app, &holder).await?;
        if let Some(h) = holder.inner.lock().await.as_mut() {
            h.audio.muted = muted;
        }
        mpv.set_muted(muted).await
    }
    #[cfg(not(windows))]
    { let _ = (app, holder, muted); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_set_audio_track(
    app: AppHandle,
    holder: State<'_, MpvHolder>,
    track_id: Option<i64>,
) -> Result<()> {
    #[cfg(windows)]
    {
        ensure_mpv(&app, &holder).await?.set_audio_track(track_id).await
    }
    #[cfg(not(windows))]
    { let _ = (app, holder, track_id); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_set_subtitle_track(
    app: AppHandle,
    holder: State<'_, MpvHolder>,
    track_id: Option<i64>,
) -> Result<()> {
    #[cfg(windows)]
    {
        ensure_mpv(&app, &holder).await?.set_subtitle_track(track_id).await
    }
    #[cfg(not(windows))]
    { let _ = (app, holder, track_id); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_set_geometry(
    app: AppHandle,
    holder: State<'_, MpvHolder>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<()> {
    #[cfg(windows)]
    {
        let child = {
            let slot = holder.inner.lock().await;
            let handles = slot.as_ref().ok_or_else(|| err!("mpv not initialized"))?;
            handles.child_hwnd
        };
        // SetWindowPos on a window owned by another thread is marshalled
        // through SendMessage into that thread's pump. Running it from the
        // main thread directly is faster and avoids cross-thread stalls
        // during rapid resize bursts (fullscreen transitions, drags).
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<()>>();
        app.run_on_main_thread(move || {
            let _ = tx.send(crate::mpv::hwnd::set_geometry(child, x, y, w, h));
        })
        .map_err(|e| err!("run_on_main_thread failed: {}", e))?;
        rx.await.map_err(|_| err!("set_geometry dropped without reply"))?
    }
    #[cfg(not(windows))]
    { let _ = (app, holder, x, y, w, h); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_stop(holder: State<'_, MpvHolder>) -> Result<()> {
    #[cfg(windows)]
    {
        // Stopping a dead mpv is already done — don't respawn just for this.
        let mpv = holder.inner.lock().await.as_ref().map(|h| h.mpv.clone());
        match mpv {
            Some(mpv) if mpv.is_alive() => mpv.stop().await,
            _ => Ok(()),
        }
    }
    #[cfg(not(windows))]
    { let _ = holder; Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_get_state(app: AppHandle, holder: State<'_, MpvHolder>) -> Result<StateSnapshot> {
    #[cfg(windows)]
    {
        let mpv = ensure_mpv(&app, &holder).await?;
        Ok(StateSnapshot::from(mpv.state_snapshot().await))
    }
    #[cfg(not(windows))]
    { let _ = (app, holder); Err(err!("windows only")) }
}

// Serializable, camelCase-renamed snapshot for the frontend. We redo this
// rather than re-export `MpvState` so the frontend-facing shape is under
// our control and the `windows`-only type doesn't leak into non-Windows
// compilation units.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub playing: bool,
    pub paused: bool,
    pub idle: bool,
    pub time_pos: Option<f64>,
    pub duration: Option<f64>,
    pub volume: Option<f64>,
    pub muted: bool,
    pub audio_tracks: Vec<TrackInfoDto>,
    pub subtitle_tracks: Vec<TrackInfoDto>,
    pub current_audio: Option<i64>,
    pub current_subtitle: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfoDto {
    pub id: i64,
    pub kind: String,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub codec: Option<String>,
    pub channels: Option<i64>,
    pub default: Option<bool>,
    pub selected: Option<bool>,
}

#[cfg(windows)]
impl From<crate::mpv::MpvState> for StateSnapshot {
    fn from(s: crate::mpv::MpvState) -> Self {
        let map = |t: crate::mpv::TrackInfo| TrackInfoDto {
            id: t.id,
            kind: t.kind,
            title: t.title,
            lang: t.lang,
            codec: t.codec,
            channels: t.channels,
            default: t.default,
            selected: t.selected,
        };
        Self {
            playing: s.playing,
            paused: s.paused,
            idle: s.idle,
            time_pos: s.time_pos,
            duration: s.duration,
            volume: s.volume,
            muted: s.muted,
            audio_tracks: s.audio_tracks.into_iter().map(map).collect(),
            subtitle_tracks: s.subtitle_tracks.into_iter().map(map).collect(),
            current_audio: s.current_audio,
            current_subtitle: s.current_subtitle,
        }
    }
}

// ---- lifecycle ----

/// Return a live mpv handle, creating the child HWND and/or (re)spawning
/// mpv as needed. Holding the slot lock across the spawn serialises
/// concurrent callers so we never start two instances.
#[cfg(windows)]
async fn ensure_mpv(app: &AppHandle, holder: &MpvHolder) -> Result<crate::mpv::Mpv> {
    use tauri::{Emitter, Manager};

    let mut slot = holder.inner.lock().await;
    if let Some(h) = slot.as_ref() {
        if h.mpv.is_alive() {
            return Ok(h.mpv.clone());
        }
        tracing::warn!(target: "lumen_lib", "mpv is not running; respawning");
    }

    let child_hwnd = match slot.as_ref() {
        Some(h) => h.child_hwnd,
        None => create_child_window(app).await?,
    };
    let audio = slot.as_ref().map(|h| h.audio).unwrap_or_default();

    // The installer ships mpv under resources/mpv/; dev builds without it
    // fall back to a system install.
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("mpv").join("mpv.exe"));
    let (mpv, mut rx) = crate::mpv::Mpv::spawn(child_hwnd, bundled.as_deref(), audio).await?;

    // Forward every state update to the frontend as `mpv://state`. The
    // channel closes when mpv's IPC task exits; if that happens while this
    // instance is still the current one, mpv died under us.
    let app_for_events = app.clone();
    let this = mpv.clone();
    tokio::spawn(async move {
        while let Some(state) = rx.recv().await {
            let _ = app_for_events.emit("mpv://state", &state);
        }
        let holder = app_for_events.state::<MpvHolder>();
        let current = holder.inner.lock().await.as_ref().map(|h| h.mpv.same_instance(&this));
        if current == Some(true) {
            tracing::error!(target: "lumen_lib", "mpv exited unexpectedly");
            let _ = app_for_events.emit("mpv://event", &serde_json::json!({ "kind": "crashed" }));
        }
    });

    *slot = Some(MpvHandles { mpv: mpv.clone(), child_hwnd, audio });
    Ok(mpv)
}

/// Create the native child window mpv renders into. Done once per app run;
/// respawns reuse it.
#[cfg(windows)]
async fn create_child_window(app: &AppHandle) -> Result<isize> {
    use tauri::{Emitter, Manager};

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| err!("main window not found"))?;
    // `window.hwnd()` returns the outer Tauri HWND (the shell that hosts
    // WebView2). Creating our mpv child underneath makes it a sibling of
    // the WebView2 surface; native siblings render on top of WebView2 in
    // our area, which is exactly what we want.
    let parent = window
        .hwnd()
        .map_err(|e| err!("window.hwnd failed: {}", e))?
        .0 as isize;
    // Windows routes messages to a window on the thread that created it.
    // Creating the child on a tokio worker thread leaves it with no message
    // pump, which causes WebView2's parent-thread message dispatches into
    // the child (WM_WINDOWPOSCHANGING, etc.) to block indefinitely — the
    // Tauri window goes "not responding". Hop the create call onto the
    // Tauri UI thread so the child shares the parent's pump.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<isize>>();
    app.run_on_main_thread(move || {
        let _ = tx.send(crate::mpv::hwnd::create_child(parent));
    })
    .map_err(|e| err!("run_on_main_thread failed: {}", e))?;
    let child = rx
        .await
        .map_err(|_| err!("create_child dropped without reply"))??;

    // mpv's process never gets WM_MOUSE* messages (cross-process `--wid`
    // means only the Tauri UI thread that created the HWND pumps them), so
    // double-click detection happens in our own wnd_proc and flows back up
    // to the frontend as `mpv://event`.
    let (hwnd_tx, mut hwnd_rx) = tokio::sync::mpsc::unbounded_channel();
    crate::mpv::hwnd::set_event_sink(hwnd_tx);
    let app_for_hwnd = app.clone();
    tokio::spawn(async move {
        while let Some(ev) = hwnd_rx.recv().await {
            match ev {
                crate::mpv::hwnd::HwndEvent::DoubleClick => {
                    let _ = app_for_hwnd
                        .emit("mpv://event", &serde_json::json!({ "kind": "double-click" }));
                }
            }
        }
    });

    tracing::info!(target: "lumen_lib", "mpv child window: child_hwnd={} parent_hwnd={}", child, parent);
    Ok(child)
}
