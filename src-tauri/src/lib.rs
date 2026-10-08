mod commands;
mod db;
mod diagnostics;
mod distribution;
mod error;
mod models;
mod parental;
mod players;
mod remote;
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

    let builder = tauri::Builder::default();
    // The Microsoft Store updates its copy itself; only the direct
    // download updates itself.
    let builder = if distribution::is_store() {
        builder
    } else {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    };
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Development builds can run against a separate data folder
            // (TENVY_DATA_DIR), e.g. with the local test provider, without
            // touching the real library.
            let dir = std::env::var_os("TENVY_DATA_DIR")
                .filter(|_| cfg!(debug_assertions))
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| app.path().app_data_dir().expect("app data dir"));
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
            commands::rename_source,
            commands::list_groups,
            commands::list_channels,
            commands::search_channels,
            commands::list_episodes,
            commands::vod_details,
            commands::add_reminder,
            commands::remove_reminder,
            commands::list_reminders,
            commands::source_stats,
            commands::app_info,
            commands::get_channel,
            commands::open_licenses,
            commands::diagnostics,
            commands::set_group_prefs,
            commands::parental_status,
            commands::parental_unlock,
            commands::parental_lock,
            commands::is_channel_locked,
            commands::set_parental_pin,
            commands::recently_added,
            commands::account_info,
            commands::list_favorites,
            commands::toggle_favorite,
            commands::reorder_favorites,
            commands::set_channel_hidden,
            commands::list_hidden_channels,
            commands::programmes_for_channels,
            commands::now_playing,
            commands::epg_offset,
            commands::distribution,
            commands::export_backup,
            commands::restore_backup,
            commands::parental_words,
            commands::set_parental_words,
            commands::set_epg_offset,
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
            commands::mpv_state::mpv_show_text,
            commands::mpv_state::mpv_adjust,
            commands::mpv_state::mpv_stream_info,
            commands::mpv_state::mpv_get_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
