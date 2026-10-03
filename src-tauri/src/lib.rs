mod commands;
mod db;
mod error;
mod models;
mod players;
mod sources;

#[cfg(windows)]
mod mpv;

use tauri::Manager;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

use commands::AppState;

/// Initialise tracing with a stderr layer (dev console) and a rolling file
/// layer (shipping builds). The file layer writes one log per day to
/// `%APPDATA%\Tenvy\logs\` on Windows — when users report "playback hangs"
/// we can ask for the latest file and actually have breadcrumbs instead of
/// guessing. Falls back to stderr-only if the directory can't be resolved.
fn init_tracing() {
    let filter = || {
        EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("tenvy_lib=info,warn"))
    };

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(filter());

    let log_dir = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .map(|p| p.join("Tenvy").join("logs"));

    let file_layer = log_dir
        .as_ref()
        .and_then(|dir| std::fs::create_dir_all(dir).ok().map(|_| dir))
        .map(|dir| {
            let appender = tracing_appender::rolling::daily(dir, "tenvy.log");
            tracing_subscriber::fmt::layer()
                .with_writer(appender)
                .with_ansi(false)
                .with_filter(filter())
        });

    let _ = tracing_subscriber::registry()
        .with(stderr_layer)
        .with(file_layer)
        .try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .expect("app data dir");
            let db_path = dir.join("tenvy.db");
            let db = db::open(&db_path).expect("open db");
            app.manage(AppState::new(db));

            // mpv boots lazily — we don't spawn it until the frontend
            // reports the Tauri window is ready and sends `mpv_init` with
            // its HWND. Doing it here would race the window's creation.
            app.manage(commands::mpv_state::MpvHolder::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sources,
            commands::add_source,
            commands::refresh_source,
            commands::remove_source,
            commands::list_groups,
            commands::list_channels,
            commands::search_channels,
            commands::list_episodes,
            commands::vod_details,
            commands::add_reminder,
            commands::remove_reminder,
            commands::list_reminders,
            commands::source_stats,
            commands::list_favorites,
            commands::toggle_favorite,
            commands::programmes_for_channels,
            commands::now_playing,
            commands::open_external,
            commands::record_history,
            commands::list_history,
            commands::list_history_progress,
            commands::get_history_entry,
            commands::remove_history_entry,
            commands::clear_history,
            // Windows-only commands are registered but compile to error
            // stubs on other platforms (see commands::mpv_state). This
            // keeps tauri's generate_handler! macro happy since it can't
            // conditionally include tokens.
            commands::mpv_state::mpv_init,
            commands::mpv_state::mpv_load,
            commands::mpv_state::mpv_load_catchup,
            commands::mpv_state::mpv_set_pause,
            commands::mpv_state::mpv_seek,
            commands::mpv_state::mpv_set_volume,
            commands::mpv_state::mpv_set_muted,
            commands::mpv_state::mpv_set_audio_track,
            commands::mpv_state::mpv_set_subtitle_track,
            commands::mpv_state::mpv_set_geometry,
            commands::mpv_state::mpv_stop,
            commands::mpv_state::mpv_get_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
