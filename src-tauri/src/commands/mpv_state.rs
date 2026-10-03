//! Tauri command surface for the embedded mpv.
//!
//! The frontend lifecycle is:
//! 1. On window ready, call `mpv_init` with the native window handle (from
//!    `@tauri-apps/api/webviewWindow`). We create a child HWND, spawn mpv,
//!    and start forwarding state updates as Tauri events.
//! 2. Frontend calls `mpv_load(url, startSeconds?)` to play.
//! 3. Play/pause/seek/volume/tracks are one-line IPC calls.
//! 4. `mpv_set_geometry` moves the native video rect to match the player
//!    panel — called whenever the React layout reports a resize.
//! 5. On window close Tauri drops AppState; we shut mpv down cleanly.
//!
//! Non-Windows builds compile to stubs so the `generate_handler!` macro
//! doesn't need conditional arms.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
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
}

// ---- commands ----

#[tauri::command]
pub async fn mpv_init(
    app: AppHandle,
    holder: State<'_, MpvHolder>,
) -> Result<()> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let mut slot = holder.inner.lock().await;
        if slot.is_some() {
            return Ok(());
        }
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| err!("main window not found"))?;
        // `window.hwnd()` returns the outer Tauri HWND (the shell that
        // hosts WebView2). Creating our mpv child underneath makes it a
        // sibling of the WebView2 surface; native siblings render on top
        // of WebView2 in our area, which is exactly what we want.
        let parent = window
            .hwnd()
            .map_err(|e| err!("window.hwnd failed: {}", e))?
            .0 as isize;
        // Windows routes messages to a window on the thread that created
        // it. Creating the child on a tokio worker thread leaves it with
        // no message pump, which causes WebView2's parent-thread message
        // dispatches into the child (WM_WINDOWPOSCHANGING, etc.) to block
        // indefinitely — the Tauri window goes "not responding". Hop the
        // create call onto the Tauri UI thread so the child is owned by
        // the same thread as the parent and shares its pump.
        let (tx, rx_child) = tokio::sync::oneshot::channel::<Result<isize>>();
        app.run_on_main_thread(move || {
            let _ = tx.send(crate::mpv::hwnd::create_child(parent));
        })
        .map_err(|e| err!("run_on_main_thread failed: {}", e))?;
        let child = rx_child
            .await
            .map_err(|_| err!("create_child dropped without reply"))??;
        let (mpv, mut rx) = crate::mpv::Mpv::spawn(child).await?;

        // Forward every state update to the frontend as a `mpv://state`
        // event. Spawned as a detached tokio task — lives until mpv exits.
        let app_for_events = app.clone();
        tokio::spawn(async move {
            while let Some(state) = rx.recv().await {
                let _ = app_for_events.emit("mpv://state", &state);
            }
        });

        // Install the HWND-level event sink *before* the wnd_proc can fire.
        // mpv's process never gets WM_MOUSE* messages (cross-process `--wid`
        // means only the Tauri UI thread that created the HWND pumps them),
        // so double-click detection has to happen in our own wnd_proc and
        // flow back up to the frontend as `mpv://event`.
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

        *slot = Some(MpvHandles { mpv, child_hwnd: child });
        tracing::info!(target: "lumen_lib", "mpv_init: child_hwnd={} parent_hwnd={}", child, parent);
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
    holder: State<'_, MpvHolder>,
    url: String,
    start_seconds: Option<f64>,
) -> Result<()> {
    #[cfg(windows)]
    {
        let mpv = take_mpv(&holder).await?;
        mpv.load(&url, start_seconds).await?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (holder, url, start_seconds);
        Err(err!("embedded mpv is only supported on Windows right now"))
    }
}

#[tauri::command]
pub async fn mpv_set_pause(holder: State<'_, MpvHolder>, paused: bool) -> Result<()> {
    #[cfg(windows)]
    {
        take_mpv(&holder).await?.set_pause(paused).await
    }
    #[cfg(not(windows))]
    { let _ = (holder, paused); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_seek(holder: State<'_, MpvHolder>, seconds: f64) -> Result<()> {
    #[cfg(windows)]
    {
        take_mpv(&holder).await?.seek_absolute(seconds).await
    }
    #[cfg(not(windows))]
    { let _ = (holder, seconds); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_set_volume(holder: State<'_, MpvHolder>, volume: f64) -> Result<()> {
    #[cfg(windows)]
    {
        take_mpv(&holder).await?.set_volume(volume).await
    }
    #[cfg(not(windows))]
    { let _ = (holder, volume); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_set_muted(holder: State<'_, MpvHolder>, muted: bool) -> Result<()> {
    #[cfg(windows)]
    {
        take_mpv(&holder).await?.set_muted(muted).await
    }
    #[cfg(not(windows))]
    { let _ = (holder, muted); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_set_audio_track(
    holder: State<'_, MpvHolder>,
    track_id: Option<i64>,
) -> Result<()> {
    #[cfg(windows)]
    {
        take_mpv(&holder).await?.set_audio_track(track_id).await
    }
    #[cfg(not(windows))]
    { let _ = (holder, track_id); Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_set_subtitle_track(
    holder: State<'_, MpvHolder>,
    track_id: Option<i64>,
) -> Result<()> {
    #[cfg(windows)]
    {
        take_mpv(&holder).await?.set_subtitle_track(track_id).await
    }
    #[cfg(not(windows))]
    { let _ = (holder, track_id); Err(err!("windows only")) }
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
        take_mpv(&holder).await?.stop().await
    }
    #[cfg(not(windows))]
    { let _ = holder; Err(err!("windows only")) }
}

#[tauri::command]
pub async fn mpv_get_state(holder: State<'_, MpvHolder>) -> Result<StateSnapshot> {
    #[cfg(windows)]
    {
        let mpv = take_mpv(&holder).await?;
        let s = mpv.state_snapshot().await;
        Ok(StateSnapshot::from(s))
    }
    #[cfg(not(windows))]
    { let _ = holder; Err(err!("windows only")) }
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
            audio_tracks: s.audio_tracks.into_iter().map(map.clone()).collect(),
            subtitle_tracks: s.subtitle_tracks.into_iter().map(map).collect(),
            current_audio: s.current_audio,
            current_subtitle: s.current_subtitle,
        }
    }
}

// ---- helpers ----

#[cfg(windows)]
async fn take_mpv(holder: &State<'_, MpvHolder>) -> Result<crate::mpv::Mpv> {
    let slot = holder.inner.lock().await;
    let h = slot.as_ref().ok_or_else(|| err!("mpv not initialized"))?;
    Ok(h.mpv.clone())
}
