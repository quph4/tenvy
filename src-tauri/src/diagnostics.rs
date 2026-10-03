//! A plain-text report for "something's wrong" messages: versions, what's
//! in the library (counts only) and the end of the log — with stream URLs,
//! logins and the Windows user name scrubbed. The user copies it and pastes
//! it into a report; nothing is sent anywhere by Tenvy.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use crate::db::{self, Db};
use crate::sources::stream_url;

const LOG_LINES: usize = 150;

pub fn report(db: &Db, data_dir: &Path, parental_pin: bool) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "Tenvy {} ({})", env!("CARGO_PKG_VERSION"), if cfg!(debug_assertions) { "dev build" } else { "release" });
    let _ = writeln!(out, "Windows: {}", windows_version());
    let _ = writeln!(out, "Data folder: {}", scrub(&data_dir.display().to_string()));

    let _ = writeln!(out, "\nProviders:");
    match db::list_sources(db) {
        Ok(sources) if !sources.is_empty() => {
            for (i, s) in sources.iter().enumerate() {
                let stats = db::source_stats(db, s.id).unwrap_or_default();
                let age = (chrono::Utc::now().timestamp() - s.updated_at).max(0) / 3600;
                let _ = writeln!(
                    out,
                    "  {}. {} — {} live, {} movies, {} series, refreshed {} h ago",
                    i + 1,
                    s.kind.as_str(),
                    stats.live,
                    stats.movies,
                    stats.series,
                    age
                );
            }
        }
        Ok(_) => {
            let _ = writeln!(out, "  (none)");
        }
        Err(e) => {
            let _ = writeln!(out, "  (couldn't read: {e})");
        }
    }

    let _ = writeln!(out, "\nLibrary: {}", db::library_summary(db).unwrap_or_else(|e| format!("(couldn't read: {e})")));
    let _ = writeln!(out, "Parental PIN: {}", if parental_pin { "set" } else { "not set" });

    let _ = writeln!(out, "\nLast {LOG_LINES} log lines:");
    match log_tail(LOG_LINES) {
        Some(lines) => {
            for line in lines {
                let _ = writeln!(out, "  {}", scrub(&line));
            }
        }
        None => {
            let _ = writeln!(out, "  (no log file)");
        }
    }
    out
}

fn log_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("Tenvy").join("logs"))
}

/// The last `n` lines across the newest daily log files.
fn log_tail(n: usize) -> Option<Vec<String>> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(log_dir()?)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|f| f.to_str()).is_some_and(|f| f.starts_with("tenvy.log")))
        .collect();
    files.sort();
    let mut lines: Vec<String> = Vec::new();
    for f in files.iter().rev().take(2).rev() {
        if let Ok(text) = std::fs::read_to_string(f) {
            lines.extend(text.lines().map(str::to_string));
        }
    }
    if lines.is_empty() {
        return None;
    }
    let start = lines.len().saturating_sub(n);
    Some(lines.split_off(start))
}

/// Mask what shouldn't leave the PC: URLs (credentials in paths and
/// queries) and the Windows user name in paths.
pub fn scrub(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    let next = |s: &str| [s.find("http://"), s.find("https://")].into_iter().flatten().min();
    while let Some(i) = next(rest) {
        out.push_str(&rest[..i]);
        let end = rest[i..]
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | ')' | ','))
            .map_or(rest.len(), |e| i + e);
        out.push_str(&stream_url::redact(&rest[i..end]));
        rest = &rest[end..];
    }
    out.push_str(rest);
    mask_user(&out)
}

fn mask_user(s: &str) -> String {
    let Ok(user) = std::env::var("USERNAME") else { return s.to_string() };
    if user.is_empty() {
        return s.to_string();
    }
    s.replace(&format!("\\Users\\{user}"), "\\Users\\<user>")
        .replace(&format!("/Users/{user}"), "/Users/<user>")
}

fn windows_version() -> String {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Ok(out) = std::process::Command::new("cmd").args(["/C", "ver"]).creation_flags(CREATE_NO_WINDOW).output() {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !v.is_empty() {
                return v;
            }
        }
    }
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_logins_are_scrubbed() {
        let line = "mpv load url=http://line.example.com:8080/live/alice/s3cret/123.ts start=None";
        let s = scrub(line);
        assert!(!s.contains("alice") && !s.contains("s3cret"), "{s}");
        assert!(s.contains("line.example.com"));
        let q = scrub("GET https://h/player_api.php?username=bob&password=pw&action=x done");
        assert!(!q.contains("bob") && !q.contains("pw&"), "{q}");
        assert!(q.ends_with(" done"));
    }
}
