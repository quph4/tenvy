//! mpv embedding layer.
//!
//! We run `mpv.exe` as a child process parented to a native child HWND we
//! create inside the Tauri main window. mpv decodes everything (HEVC/AC-3/
//! DTS/TrueHD/MKV) natively, so the frontend no longer hands anything to
//! `<video>`. Communication is JSON-over-named-pipe (mpv's documented
//! `--input-ipc-server` protocol).
//!
//! Why subprocess instead of libmpv: building against libmpv on Windows
//! requires extracting `mpv-dev-*.7z`, setting MPV_SOURCE, and shipping
//! the matching DLL. Subprocess keeps dependencies to `mpv.exe` (which the
//! user already has installed for the external-player fallback) and gives
//! us the same embedding quality via `--wid`.
//!
//! Architecture:
//! - A single background task owns the named pipe. It uses `tokio::select!`
//!   to interleave (a) reading JSON lines from mpv and (b) draining a
//!   command queue from the rest of the app. This sidesteps tokio's
//!   NamedPipeClient not being splittable and avoids the "reply arrives on
//!   the write connection" problem that kills two-pipe designs.
//! - Callers submit commands through an mpsc channel; each command carries
//!   a oneshot for its reply. The task matches replies by `request_id`.
//! - Property-change events update a shared snapshot and fan out to
//!   `state_tx` so the frontend can listen.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::err;
use crate::error::Result;

pub mod hwnd;

/// Minimum spacing between state emits caused purely by `time-pos`.
const TIME_POS_EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// State the frontend cares about. Emitted as a Tauri event whenever any
/// observed property changes. Values are Option because mpv reports
/// "property-unavailable" between files; UI should tolerate missing data.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvState {
    pub playing: bool,
    pub paused: bool,
    pub idle: bool,
    pub time_pos: Option<f64>,
    pub duration: Option<f64>,
    pub volume: Option<f64>,
    pub muted: bool,
    pub audio_tracks: Vec<TrackInfo>,
    pub subtitle_tracks: Vec<TrackInfo>,
    pub current_audio: Option<i64>,
    pub current_subtitle: Option<i64>,
}

/// One track as reported by mpv's `track-list`. `id` is the `aid`/`sid`
/// value — the authoritative handle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub codec: Option<String>,
    pub channels: Option<i64>,
    pub default: Option<bool>,
    pub selected: Option<bool>,
}

/// One outstanding command: the JSON to write, and where to send its reply.
struct CommandSubmission {
    payload: String,
    id: u64,
    reply: oneshot::Sender<Value>,
}

/// Public handle. Clone cheap — everything lives behind Arcs internally.
#[derive(Clone)]
pub struct Mpv {
    tx: mpsc::UnboundedSender<CommandSubmission>,
    state: Arc<Mutex<MpvState>>,
    request_id: Arc<AtomicU64>,
    child_pid: u32,
}

impl Mpv {
    /// Spawn mpv parented to the given HWND. Returns the handle plus a
    /// receiver the caller drains to forward state updates to the frontend.
    pub async fn spawn(
        hwnd: isize,
    ) -> Result<(Self, mpsc::UnboundedReceiver<MpvState>)> {
        let pipe_name = format!(r"\\.\pipe\lumen-mpv-{}", std::process::id());
        let mpv_path = find_mpv_exe().ok_or_else(|| {
            err!("mpv.exe not found. Install mpv from https://mpv.io and ensure it's on PATH or in Program Files.")
        })?;

        // Core embedding flags. See https://mpv.io/manual/stable/#options.
        // mpv logs diagnostics via `--log-file` rather than stderr — on
        // Windows, a std::process::Command with Stdio::inherit routes to
        // the parent's actual console handle, which pnpm/Tauri's dev
        // pipeline never attaches, so we lose every line. A log file is
        // trivial to tail and survives crashes.
        let log_path = std::env::temp_dir().join("lumen-mpv.log");
        let child = std::process::Command::new(&mpv_path)
            .arg(format!("--wid={}", hwnd))
            .arg(format!("--input-ipc-server={}", pipe_name))
            .arg(format!("--log-file={}", log_path.display()))
            .arg("--idle=yes")
            .arg("--force-window=yes")
            .arg("--keep-open=yes")
            // Hardware decode is intentionally OFF. On Windows, a child HWND
            // parented under a WebView2 host does not composite d3d11va
            // swap-chains reliably — you get a black rect even though mpv
            // thinks it's decoding fine. Software decode is plenty fast for
            // 1080p and can be upgraded later behind a user toggle once we
            // confirm the embedding path itself is stable.
            .arg("--hwdec=no")
            // D3D11 swap chain via DXGI. OpenGL + WGL looks like it works
            // (mpv logs "first video frame shown", presents into the HWND's
            // DC) but DWM doesn't composite the result when the parent
            // window hosts a DirectComposition visual tree — which Tauri's
            // WebView2 host does. The symptom is a solid-black rect exactly
            // where mpv says it's drawing. DXGI swap chains register with
            // DWM directly and composite above the parent's DComp surface
            // regardless of HWND Z-order quirks, which is why this is the
            // standard recipe for `--wid` embedding under WebView2 / CEF /
            // any composition-hosted parent.
            .arg("--vo=gpu-next")
            .arg("--gpu-api=d3d11")
            // yt-dlp isn't bundled; skip the three-subprocess fallback when
            // a direct HTTP open fails. Surfaces errors immediately instead
            // of hanging for 10s.
            .arg("--ytdl=no")
            // No OSC — we render the full control strip in React below the
            // video rect. OSC would paint *inside* the native surface, which
            // our HTML can't reach, so it'd trap clicks we want on scrub.
            .arg("--osc=no")
            .arg("--no-terminal")
            // Streaming IPTV needs a buffer so scrub/seek don't stall while
            // the demuxer re-fetches. 150 MB is ~90s of 1080p H.264.
            .arg("--cache=yes")
            .arg("--demuxer-max-bytes=150MiB")
            .arg("--demuxer-max-back-bytes=75MiB")
            // Most Xtream providers 403 mpv's default UA. Masquerade as a
            // recent Chrome — cheap, ubiquitous, and legitimate since the
            // user has a paid subscription.
            .arg("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
            // Verbose so the log file actually tells us *why* things fail.
            .arg("--msg-level=all=v")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| err!("failed to spawn mpv ({}): {}", mpv_path, e))?;
        tracing::info!(target: "lumen_lib", "mpv log file: {}", log_path.display());

        let child_pid = child.id();
        tracing::info!(
            target: "lumen_lib",
            "spawned mpv pid={} wid={} pipe={}",
            child_pid, hwnd, pipe_name
        );

        // mpv takes ~100ms to bind its named pipe.
        let pipe = connect_pipe(&pipe_name).await?;

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<CommandSubmission>();
        let (state_tx, state_rx) = mpsc::unbounded_channel::<MpvState>();
        let state = Arc::new(Mutex::new(MpvState::default()));

        // One task owns the pipe and handles both directions.
        let task_state = state.clone();
        tokio::spawn(async move {
            pipe_task(pipe, cmd_rx, task_state, state_tx, child).await;
        });

        let mpv = Self {
            tx: cmd_tx,
            state,
            request_id: Arc::new(AtomicU64::new(1)),
            child_pid,
        };

        // Register observers so every property we care about pushes events.
        mpv.observe_properties().await?;
        Ok((mpv, state_rx))
    }

    /// Send an mpv IPC command and await the reply. `args` is mpv's input
    /// command array — see https://mpv.io/manual/stable/#list-of-input-commands.
    pub async fn command(&self, args: &[Value]) -> Result<Value> {
        let id = self.request_id.fetch_add(1, Ordering::Relaxed);
        let payload = json!({ "command": args, "request_id": id });
        let line = format!("{}\n", serde_json::to_string(&payload)?);
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(CommandSubmission { payload: line, id, reply: tx })
            .map_err(|_| err!("mpv IPC task gone"))?;
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(v)) => {
                if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
                    if err != "success" {
                        return Err(err!("mpv error on {:?}: {}", args, err));
                    }
                }
                Ok(v)
            }
            Ok(Err(_)) => Err(err!("mpv IPC reply channel dropped")),
            Err(_) => Err(err!("mpv IPC timeout on {:?}", args)),
        }
    }

    pub async fn set_property(&self, name: &str, value: Value) -> Result<()> {
        self.command(&[json!("set_property"), json!(name), value]).await?;
        Ok(())
    }

    pub async fn load(&self, url: &str, start_seconds: Option<f64>) -> Result<()> {
        tracing::info!(target: "lumen_lib", "mpv load url={} start={:?}", url, start_seconds);
        let args: Vec<Value> = if let Some(t) = start_seconds.filter(|t| *t > 1.0) {
            // Options dict applied before the first frame — `start=` resumes.
            vec![
                json!("loadfile"),
                json!(url),
                json!("replace"),
                json!(0),
                json!(format!("start={:.3}", t)),
            ]
        } else {
            vec![json!("loadfile"), json!(url), json!("replace")]
        };
        self.command(&args).await?;
        Ok(())
    }

    pub async fn set_pause(&self, paused: bool) -> Result<()> {
        self.set_property("pause", json!(paused)).await
    }

    pub async fn seek_absolute(&self, seconds: f64) -> Result<()> {
        tracing::debug!(target: "lumen_lib", "mpv seek absolute={}", seconds);
        self.command(&[json!("seek"), json!(seconds), json!("absolute")]).await?;
        Ok(())
    }

    pub async fn set_volume(&self, vol_0_100: f64) -> Result<()> {
        self.set_property("volume", json!(vol_0_100.clamp(0.0, 100.0))).await
    }

    pub async fn set_muted(&self, muted: bool) -> Result<()> {
        self.set_property("mute", json!(muted)).await
    }

    pub async fn set_audio_track(&self, track_id: Option<i64>) -> Result<()> {
        let v = match track_id {
            Some(id) => json!(id),
            None => json!("no"),
        };
        self.set_property("aid", v).await
    }

    pub async fn set_subtitle_track(&self, track_id: Option<i64>) -> Result<()> {
        let v = match track_id {
            Some(id) => json!(id),
            None => json!("no"),
        };
        self.set_property("sid", v).await
    }

    pub async fn stop(&self) -> Result<()> {
        // `stop` unloads the current file and returns mpv to idle.
        self.command(&[json!("stop")]).await?;
        Ok(())
    }

    pub async fn state_snapshot(&self) -> MpvState {
        self.state.lock().await.clone()
    }

    pub fn pid(&self) -> u32 {
        self.child_pid
    }

    async fn observe_properties(&self) -> Result<()> {
        for (i, name) in [
            "time-pos",
            "duration",
            "pause",
            "idle-active",
            "volume",
            "mute",
            "track-list",
            "core-idle",
            "eof-reached",
        ]
        .iter()
        .enumerate()
        {
            self.command(&[
                json!("observe_property"),
                json!(i as u64 + 1),
                json!(name),
            ])
            .await?;
        }
        Ok(())
    }

    /// Ask mpv to quit. The pipe task will exit on its own when the pipe
    /// closes; it also reaps the child process.
    pub async fn shutdown(&self) {
        let _ = self.command(&[json!("quit")]).await;
    }
}

// ---- pipe task ----

/// Runs for the lifetime of mpv. Owns the NamedPipeClient outright so
/// reads and writes can interleave without a shared-lock deadlock.
async fn pipe_task(
    pipe: NamedPipeClient,
    mut cmd_rx: mpsc::UnboundedReceiver<CommandSubmission>,
    state: Arc<Mutex<MpvState>>,
    state_tx: mpsc::UnboundedSender<MpvState>,
    mut child: std::process::Child,
) {
    // Split the pipe by using BufReader on a mutable reference half of it.
    // Since NamedPipeClient implements AsyncRead+AsyncWrite directly, we
    // keep it behind a mutable binding and use `tokio::io::split` to get
    // owned halves.
    let (rh, mut wh) = tokio::io::split(pipe);
    let mut reader = BufReader::new(rh).lines();

    // pending request_id → reply sender
    let mut pending: HashMap<u64, oneshot::Sender<Value>> = HashMap::new();
    let mut last_time_emit = Instant::now() - TIME_POS_EMIT_INTERVAL;

    loop {
        tokio::select! {
            // Inbound: a new command to write to mpv.
            Some(sub) = cmd_rx.recv() => {
                if wh.write_all(sub.payload.as_bytes()).await.is_err() {
                    // Pipe closed mid-write — return error to caller and bail.
                    let _ = sub.reply.send(json!({"error": "pipe closed"}));
                    break;
                }
                if wh.flush().await.is_err() { break; }
                pending.insert(sub.id, sub.reply);
            }
            // Inbound from mpv: replies + events.
            line = reader.next_line() => {
                let line = match line {
                    Ok(Some(l)) => l,
                    _ => break, // pipe closed
                };
                if line.is_empty() { continue; }
                let val: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::debug!(target: "lumen_lib", "mpv non-JSON: {} ({})", line, e);
                        continue;
                    }
                };
                // Command reply?
                if let Some(id) = val.get("request_id").and_then(|v| v.as_u64()) {
                    if let Some(tx) = pending.remove(&id) {
                        let _ = tx.send(val);
                        continue;
                    }
                }
                // Event?
                if let Some(event) = val.get("event").and_then(|v| v.as_str()) {
                    let mut s = state.lock().await;
                    match event {
                        "property-change" => {
                            let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let data = val.get("data").cloned().unwrap_or(Value::Null);
                            apply_property(&mut s, name, &data);
                            // mpv reports time-pos on every frame. Each emit
                            // serialises the whole snapshot across IPC and
                            // re-renders the controls, so throttle position-
                            // only updates. Any other change still emits at
                            // once and carries the latest position with it.
                            if name == "time-pos" {
                                if last_time_emit.elapsed() < TIME_POS_EMIT_INTERVAL {
                                    continue;
                                }
                                last_time_emit = Instant::now();
                            }
                        }
                        "start-file" => {
                            s.playing = true;
                            s.idle = false;
                        }
                        "end-file" => {
                            s.playing = false;
                        }
                        "file-loaded" => {
                            s.idle = false;
                        }
                        _ => {}
                    }
                    let snap = s.clone();
                    drop(s);
                    let _ = state_tx.send(snap);
                }
            }
        }
    }

    tracing::warn!(target: "lumen_lib", "mpv pipe task exiting; reaping child");
    // Give mpv a moment to exit on its own (e.g. after `quit`), then kill.
    for _ in 0..20 {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
            Err(_) => break,
        }
    }
    let _ = child.kill();
    // Final state: idle, not playing, so the UI settles.
    let mut s = state.lock().await;
    s.playing = false;
    s.idle = true;
    let _ = state_tx.send(s.clone());
}

fn apply_property(s: &mut MpvState, name: &str, v: &Value) {
    match name {
        "time-pos" => s.time_pos = v.as_f64(),
        "duration" => s.duration = v.as_f64(),
        "pause" => s.paused = v.as_bool().unwrap_or(false),
        "idle-active" => s.idle = v.as_bool().unwrap_or(false),
        "volume" => s.volume = v.as_f64(),
        "mute" => s.muted = v.as_bool().unwrap_or(false),
        "core-idle" => s.playing = !v.as_bool().unwrap_or(true),
        "track-list" => {
            if let Some(arr) = v.as_array() {
                let mut audio = Vec::new();
                let mut subtitle = Vec::new();
                let mut current_a = None;
                let mut current_s = None;
                for t in arr {
                    let kind = t.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    let info = TrackInfo {
                        id: t.get("id").and_then(|x| x.as_i64()).unwrap_or(0),
                        kind: kind.to_string(),
                        title: t.get("title").and_then(|x| x.as_str()).map(String::from),
                        lang: t.get("lang").and_then(|x| x.as_str()).map(String::from),
                        codec: t.get("codec").and_then(|x| x.as_str()).map(String::from),
                        channels: t.get("demux-channel-count").and_then(|x| x.as_i64()),
                        default: t.get("default").and_then(|x| x.as_bool()),
                        selected: t.get("selected").and_then(|x| x.as_bool()),
                    };
                    let is_selected = info.selected.unwrap_or(false);
                    match kind {
                        "audio" => {
                            if is_selected { current_a = Some(info.id); }
                            audio.push(info);
                        }
                        "sub" => {
                            if is_selected { current_s = Some(info.id); }
                            subtitle.push(info);
                        }
                        _ => {}
                    }
                }
                s.audio_tracks = audio;
                s.subtitle_tracks = subtitle;
                s.current_audio = current_a;
                s.current_subtitle = current_s;
            }
        }
        _ => {}
    }
}

// ---- named pipe connect with retry ----

async fn connect_pipe(name: &str) -> Result<NamedPipeClient> {
    for _ in 0..100 {
        match ClientOptions::new().open(name) {
            Ok(p) => return Ok(p),
            Err(e) if e.raw_os_error() == Some(2) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) if e.raw_os_error() == Some(231) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) => return Err(err!("failed to open mpv IPC pipe {}: {}", name, e)),
        }
    }
    Err(err!("mpv IPC pipe {} never appeared", name))
}

// ---- mpv.exe discovery ----

fn find_mpv_exe() -> Option<String> {
    // `MPV Player` is the folder the shinchiro winget installer uses (via
    // the 0GMou/mpv2winget wrapper). Plain `mpv` is what `choco install mpv`
    // and some manual zips drop.
    const DIRECT: &[&str] = &[
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files (x86)\mpv\mpv.exe",
        r"C:\Program Files\MPV Player\mpv.exe",
        r"C:\Program Files (x86)\MPV Player\mpv.exe",
    ];
    for p in DIRECT {
        if std::path::Path::new(p).exists() {
            return Some((*p).to_string());
        }
    }
    for env_var in ["LOCALAPPDATA", "APPDATA"] {
        if let Ok(base) = std::env::var(env_var) {
            let p = format!(r"{}\mpv\mpv.exe", base);
            if std::path::Path::new(&p).exists() {
                return Some(p);
            }
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(';').filter(|d| !d.is_empty()) {
            let full = std::path::Path::new(dir).join("mpv.exe");
            if full.exists() {
                return Some(full.to_string_lossy().into_owned());
            }
        }
    }
    None
}
