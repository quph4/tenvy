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
use std::path::{Path, PathBuf};
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
use crate::sources::stream_url;

pub mod hwnd;

/// Pause between closing one stream and opening the next (see `load`).
const SWITCH_GAP: Duration = Duration::from_millis(300);

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
    /// Bumped each time a file fails to open (end-file with reason
    /// "error"), so the frontend can react once per failure.
    pub error_seq: u64,
    /// mpv's `file_error` for the latest failure, e.g. "loading failed".
    pub last_error: Option<String>,
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
    /// mpv < 0.38 has no `index` argument in `loadfile`; options follow
    /// the flags directly. Matters only for an old system mpv fallback.
    legacy_loadfile: bool,
}

/// Audio settings to start a fresh mpv instance with.
#[derive(Debug, Clone, Copy)]
pub struct InitialAudio {
    /// mpv units, 0..100.
    pub volume: f64,
    pub muted: bool,
}

impl Default for InitialAudio {
    fn default() -> Self {
        Self { volume: 80.0, muted: false }
    }
}

impl Mpv {
    /// Spawn mpv parented to the given HWND. Returns the handle plus a
    /// receiver the caller drains to forward state updates to the frontend.
    ///
    /// `bundled` is the mpv.exe shipped inside the installer, if any; it
    /// wins over a system install so every user runs the version we tested.
    /// `audio` seeds volume/mute so a respawn after a crash doesn't come
    /// back at mpv's default 100% volume.
    pub async fn spawn(
        hwnd: isize,
        bundled: Option<&Path>,
        audio: InitialAudio,
    ) -> Result<(Self, mpsc::UnboundedReceiver<MpvState>)> {
        // Unique per spawn: a respawn must not collide with a pipe the
        // previous (dying) instance may still hold open.
        static SPAWN_SEQ: AtomicU64 = AtomicU64::new(0);
        let pipe_name = format!(
            r"\\.\pipe\tenvy-mpv-{}-{}",
            std::process::id(),
            SPAWN_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let mpv_path = find_mpv_exe(bundled).ok_or_else(|| {
            err!("mpv.exe not found. Reinstall Tenvy, or install mpv from https://mpv.io.")
        })?;

        let mut cmd = std::process::Command::new(&mpv_path);
        // Ignore the user's own mpv.conf / input.conf / scripts: a
        // personal config (a different vo, an OSC replacement, key
        // bindings) must not change how the embedded player behaves.
        // Everything we rely on is passed explicitly below.
        cmd.arg("--no-config")
            .arg(format!("--wid={}", hwnd))
            .arg(format!("--input-ipc-server={}", pipe_name))
            .arg(format!("--volume={}", audio.volume.clamp(0.0, 100.0)))
            .arg(format!("--mute={}", if audio.muted { "yes" } else { "no" }));

        // mpv logs diagnostics via `--log-file` rather than stderr — on
        // Windows, a std::process::Command with Stdio::inherit routes to
        // the parent's actual console handle, which pnpm/Tauri's dev
        // pipeline never attaches, so we lose every line. The log is
        // verbose and contains full stream URLs (credentials included), so
        // release builds only write it when TENVY_MPV_LOG is set — support
        // can ask a user to turn it on.
        if cfg!(debug_assertions) || std::env::var_os("TENVY_MPV_LOG").is_some() {
            let log_path = std::env::temp_dir().join("tenvy-mpv.log");
            cmd.arg(format!("--log-file={}", log_path.display()))
                .arg("--msg-level=all=v");
            tracing::info!(target: "tenvy_lib", "mpv log file: {}", log_path.display());
        }

        // Hardware decoding in copy-back mode: frames are decoded on the
        // GPU, then copied to system memory and presented through exactly
        // the same path as software decoding. Direct d3d11va presentation
        // has shown black rects under the WebView2 host, but copy-back
        // never touches that path, and takes 4K HEVC off the CPU.
        // TENVY_HWDEC overrides for troubleshooting (e.g. `no`).
        let hwdec = std::env::var("TENVY_HWDEC").unwrap_or_else(|_| "auto-copy-safe".into());

        let child = cmd
            .arg("--idle=yes")
            .arg("--force-window=yes")
            .arg("--keep-open=yes")
            .arg(format!("--hwdec={}", hwdec))
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
            // On-screen messages (channel info, reminders) are drawn by
            // mpv: in fullscreen the native surface covers the webview, so
            // this is the only text that can appear over the picture.
            // Options here exist in every mpv we support.
            .arg("--osd-font=Segoe UI")
            .arg("--osd-font-size=40")
            .arg("--osd-color=#F5F5F5")
            .arg("--osd-border-color=#B0000000")
            .arg("--osd-border-size=2")
            .arg("--osd-shadow-offset=0")
            .arg("--osd-margin-x=56")
            .arg("--osd-margin-y=44")
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
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| err!("failed to spawn mpv ({}): {}", mpv_path.display(), e))?;
        job::adopt(&child);

        tracing::info!(
            target: "tenvy_lib",
            "spawned mpv {} pid={} wid={} pipe={}",
            mpv_path.display(), child.id(), hwnd, pipe_name
        );

        // mpv takes ~100ms to bind its named pipe.
        let mut child = child;
        let pipe = match connect_pipe(&pipe_name).await {
            Ok(p) => p,
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        };

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
            legacy_loadfile: false,
        };

        // Register observers so every property we care about pushes events.
        if let Err(e) = mpv.observe_properties().await {
            // The pipe task owns the child now; ask mpv to exit rather
            // than leave a half-initialised instance running.
            let _ = mpv.command(&[json!("quit")]).await;
            return Err(e);
        }
        let mut mpv = mpv;
        let version = mpv
            .command(&[json!("get_property"), json!("mpv-version")])
            .await
            .ok()
            .and_then(|v| v.get("data").and_then(|d| d.as_str()).map(str::to_string))
            .unwrap_or_default();
        mpv.legacy_loadfile = is_pre_0_38(&version);
        tracing::info!(target: "tenvy_lib", "{} (legacy loadfile: {})", version, mpv.legacy_loadfile);
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
        // Errors name only the command, never its arguments: `loadfile`'s
        // argument is a stream URL that usually embeds credentials.
        let name = args.first().and_then(|v| v.as_str()).unwrap_or("?");
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(v)) => {
                if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
                    if err != "success" {
                        return Err(err!("mpv error on {}: {}", name, err));
                    }
                }
                Ok(v)
            }
            Ok(Err(_)) => Err(err!("mpv IPC reply channel dropped")),
            Err(_) => Err(err!("mpv IPC timeout on {}", name)),
        }
    }

    pub async fn set_property(&self, name: &str, value: Value) -> Result<()> {
        self.command(&[json!("set_property"), json!(name), value]).await?;
        Ok(())
    }

    /// Open a stream. `user_agent` / `referrer` override the global defaults
    /// for this file only — some providers require a specific player UA.
    pub async fn load(
        &self,
        url: &str,
        start_seconds: Option<f64>,
        user_agent: Option<&str>,
        referrer: Option<&str>,
        extra_options: &[String],
    ) -> Result<()> {
        stream_url::validate(url)?;
        tracing::info!(
            target: "tenvy_lib",
            "mpv load url={} start={:?} ua={} referrer={}",
            stream_url::redact(url),
            start_seconds,
            user_agent.is_some(),
            referrer.is_some()
        );

        // File-local options, applied before the first frame (`start=`
        // resumes). Values use mpv's `%len%value` quoting so commas and
        // equals signs inside a user agent can't break the list.
        let mut options = Vec::new();
        if let Some(t) = start_seconds.filter(|t| *t > 1.0) {
            options.push(format!("start={:.3}", t));
        }
        for (key, value) in [("user-agent", user_agent), ("referrer", referrer)] {
            if let Some(v) = value {
                options.push(format!("{}=%{}%{}", key, v.len(), v));
            }
        }
        options.extend(extra_options.iter().cloned());

        // Close the current stream before opening the next. `loadfile
        // replace` alone opens the new connection while the old one is
        // still being torn down, and providers that allow a single
        // connection reject the newcomer. A short pause lets the panel see
        // the first connection go.
        if !self.state.lock().await.idle {
            let _ = self.command(&[json!("stop")]).await;
            tokio::time::sleep(SWITCH_GAP).await;
        }

        let mut args = vec![json!("loadfile"), json!(url), json!("replace")];
        if !options.is_empty() {
            // index (-1 = unused by `replace`), then the options list.
            if !self.legacy_loadfile {
                args.push(json!(-1));
            }
            args.push(json!(options.join(",")));
        }
        self.command(&args).await?;
        Ok(())
    }

    pub async fn set_pause(&self, paused: bool) -> Result<()> {
        self.set_property("pause", json!(paused)).await
    }

    pub async fn seek_absolute(&self, seconds: f64) -> Result<()> {
        tracing::debug!(target: "tenvy_lib", "mpv seek absolute={}", seconds);
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

    /// Show a message over the video for `duration_ms`. JSON IPC commands
    /// don't expand `${…}`, so the text is shown exactly as given.
    pub async fn show_text(&self, text: &str, duration_ms: u32) -> Result<()> {
        self.command(&[json!("show-text"), json!(text), json!(duration_ms)]).await?;
        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        // `stop` unloads the current file and returns mpv to idle.
        self.command(&[json!("stop")]).await?;
        Ok(())
    }

    pub async fn state_snapshot(&self) -> MpvState {
        self.state.lock().await.clone()
    }

    /// False once the IPC task has exited — mpv quit, crashed, or the pipe
    /// broke. Callers respawn rather than keep talking to a dead handle.
    pub fn is_alive(&self) -> bool {
        !self.tx.is_closed()
    }

    /// Whether two handles refer to the same spawned process.
    pub fn same_instance(&self, other: &Mpv) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
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
}

/// Parse "mpv v0.37.0-…" / "mpv 0.36.0" and report whether it predates
/// the `loadfile` index argument (0.38). Unknown versions count as modern.
fn is_pre_0_38(version: &str) -> bool {
    let digits = version
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .trim_start_matches('v');
    let mut parts = digits.split(|c: char| !c.is_ascii_digit());
    match (parts.next().and_then(|m| m.parse::<u32>().ok()), parts.next().and_then(|n| n.parse::<u32>().ok())) {
        (Some(major), Some(minor)) => major == 0 && minor < 38,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn detects_old_mpv() {
        assert!(super::is_pre_0_38("mpv v0.37.0-123-gabc Copyright"));
        assert!(super::is_pre_0_38("mpv 0.35.1"));
        assert!(!super::is_pre_0_38("mpv v0.41.0-244-gaf9c81fa1"));
        assert!(!super::is_pre_0_38("mpv v1.0.0"));
        assert!(!super::is_pre_0_38("garbage"));
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
                        tracing::debug!(target: "tenvy_lib", "mpv non-JSON: {} ({})", line, e);
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
                            if val.get("reason").and_then(|r| r.as_str()) == Some("error") {
                                s.error_seq += 1;
                                s.last_error = val
                                    .get("file_error")
                                    .and_then(|e| e.as_str())
                                    .map(str::to_string);
                            }
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

    tracing::warn!(target: "tenvy_lib", "mpv pipe task exiting; reaping child");
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

fn find_mpv_exe(bundled: Option<&Path>) -> Option<PathBuf> {
    bundled
        .filter(|p| p.is_file())
        .map(Path::to_path_buf)
        .or_else(crate::players::find_system_mpv)
}

// ---- process lifetime ----

/// Ties mpv's lifetime to ours. Every mpv we spawn is put in a Windows job
/// object with KILL_ON_JOB_CLOSE; the job handle is held (never closed) for
/// the life of this process, so when Tenvy exits — cleanly, via a crash, or
/// killed from Task Manager — the OS closes the handle and kills mpv too.
/// Without this an orphaned mpv.exe can keep playing audio after Tenvy is
/// gone.
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    fn job() -> Option<HANDLE> {
        // HANDLE isn't Send/Sync, so park the raw value.
        static JOB: OnceLock<Option<isize>> = OnceLock::new();
        let raw = JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(None, PCWSTR::null()).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
            Some(job.0 as isize)
        });
        raw.map(|h| HANDLE(h as *mut _))
    }

    pub fn adopt(child: &std::process::Child) {
        let Some(job) = job() else {
            tracing::warn!(target: "tenvy_lib", "could not create job object; mpv may outlive Tenvy");
            return;
        };
        let process = HANDLE(child.as_raw_handle());
        if let Err(e) = unsafe { AssignProcessToJobObject(job, process) } {
            tracing::warn!(target: "tenvy_lib", "AssignProcessToJobObject failed: {}", e);
        }
    }
}
