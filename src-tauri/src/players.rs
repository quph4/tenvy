//! Locating media player executables installed on the system.
//!
//! The embedded player prefers the mpv.exe bundled with the installer (see
//! `commands::mpv_state`); these lookups are the fallback for dev builds and
//! the source of the "open in external player" targets.

use std::path::{Path, PathBuf};

/// A system-wide mpv install. `MPV Player` is the folder the shinchiro
/// winget installer uses (via the 0GMou/mpv2winget wrapper); plain `mpv` is
/// what `choco install mpv` and manual zips drop. Per-user installs land
/// under LOCALAPPDATA / APPDATA. PATH is checked last.
pub fn find_system_mpv() -> Option<PathBuf> {
    first_existing(&[
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files (x86)\mpv\mpv.exe",
        r"C:\Program Files\MPV Player\mpv.exe",
        r"C:\Program Files (x86)\MPV Player\mpv.exe",
    ])
    .or_else(|| {
        ["LOCALAPPDATA", "APPDATA"].iter().find_map(|var| {
            let p = PathBuf::from(std::env::var_os(var)?).join("mpv").join("mpv.exe");
            p.is_file().then_some(p)
        })
    })
    .or_else(|| on_path("mpv.exe"))
}

pub fn find_vlc() -> Option<PathBuf> {
    first_existing(&[
        r"C:\Program Files\VideoLAN\VLC\vlc.exe",
        r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
    ])
    .or_else(|| on_path("vlc.exe"))
}

fn first_existing(candidates: &[&str]) -> Option<PathBuf> {
    candidates.iter().map(Path::new).find(|p| p.is_file()).map(Path::to_path_buf)
}

fn on_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|p| p.is_file())
}
