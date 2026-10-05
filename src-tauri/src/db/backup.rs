//! Backup and restore of everything the viewer set up: providers (with
//! their logins), favorites, hidden channels, category choices, watch
//! progress, the parental lock and the guide time adjustment.
//!
//! Channels are referred to by their identity across refreshes
//! (`channel_key`), not by row id: on another PC the same playlist gets
//! other ids. Restoring adds the providers that are missing, imports them,
//! and then matches everything up by key. It only ever adds: nothing the
//! other install already has is removed, unlocked or shown again.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{channel_key, Db, EPG_OFFSET_KEY};
use crate::err;
use crate::error::Result;

/// Bumped when the file's shape changes incompatibly.
pub const FORMAT: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub app: String,
    pub format: u32,
    pub version: String,
    pub created_at: i64,
    pub sources: Vec<BackupSource>,
    #[serde(default)]
    pub favorites: Vec<Favorite>,
    #[serde(default)]
    pub hidden_channels: Vec<ChannelRef>,
    #[serde(default)]
    pub categories: Vec<Category>,
    #[serde(default)]
    pub history: Vec<Watched>,
    #[serde(default)]
    pub lock_words: Vec<String>,
    #[serde(default)]
    pub epg_offset_minutes: i64,
    /// The parental PIN, salted and hashed as stored.
    #[serde(default)]
    pub parental_pin: Option<String>,
    /// UI preferences (the webview's own storage), passed through.
    #[serde(default)]
    pub settings: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSource {
    /// This source's number within the file (its id where it was saved).
    pub r#ref: i64,
    pub kind: String,
    pub name: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// A channel, film, show or episode by identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRef {
    pub source: i64,
    pub key: String,
    /// For an episode: its show's key (episodes are fetched per show).
    #[serde(default)]
    pub show: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    #[serde(flatten)]
    pub channel: ChannelRef,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub source: i64,
    pub kind: String,
    pub name: String,
    pub hidden: bool,
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watched {
    #[serde(flatten)]
    pub channel: ChannelRef,
    pub time_pos: f64,
    pub duration: f64,
    pub watched_at: i64,
    pub finished: bool,
}

/// What a restore brought in.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub sources_added: usize,
    /// Providers that couldn't be imported, with why.
    pub sources_failed: Vec<String>,
    pub favorites: usize,
    pub hidden_channels: usize,
    pub categories: usize,
    pub history: usize,
    /// Items whose channel the provider no longer lists.
    pub not_found: usize,
    /// The backup's parental PIN is now the PIN here.
    pub pin_restored: bool,
    pub settings: serde_json::Value,
}

/// Whether a source's rows are keyed on Xtream stream ids (see `channel_key`).
fn xtream_ids(kind: &str, url: &str) -> bool {
    kind == "xtream" || crate::sources::xtream::credentials_from_m3u_url(url).is_some()
}

// ---------- export ----------

pub fn export(db: &Db, version: &str, settings: serde_json::Value) -> Result<Backup> {
    let conn = db.read();

    let mut sources = Vec::new();
    let mut keyed: HashMap<i64, bool> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, kind, name, url, username, password FROM sources ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(BackupSource {
                r#ref: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                url: r.get(3)?,
                username: r.get(4)?,
                password: r.get(5)?,
            })
        })?;
        for s in rows {
            let s = s?;
            keyed.insert(s.r#ref, xtream_ids(&s.kind, &s.url));
            sources.push(s);
        }
    }

    // A channel row → its reference. Episodes are always keyed on ids.
    let reference = |source: i64, url: &str, show_url: Option<String>| -> ChannelRef {
        let ids = keyed.get(&source).copied().unwrap_or(false);
        match show_url {
            Some(show) => ChannelRef { source, key: channel_key(url, true), show: Some(channel_key(&show, ids)) },
            None => ChannelRef { source, key: channel_key(url, ids), show: None },
        }
    };
    const CHANNEL: &str = "c.source_id, c.stream_url, (SELECT p.stream_url FROM channels p WHERE p.id = c.parent_id)";

    let mut favorites = Vec::new();
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT {CHANNEL}, COALESCE(f.position, 0) FROM favorites f JOIN channels c ON c.id = f.channel_id
              ORDER BY f.position"
        ))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get(2)?, r.get(3)?)))?;
        for row in rows {
            let (source, url, show, position) = row?;
            favorites.push(Favorite { channel: reference(source, &url, show), position });
        }
    }

    let mut hidden_channels = Vec::new();
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT {CHANNEL} FROM hidden_channels h JOIN channels c ON c.id = h.channel_id"
        ))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get(2)?)))?;
        for row in rows {
            let (source, url, show) = row?;
            hidden_channels.push(reference(source, &url, show));
        }
    }

    let mut categories = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT source_id, kind, name, hidden, locked FROM group_prefs")?;
        let rows = stmt.query_map([], |r| {
            Ok(Category {
                source: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                hidden: r.get::<_, i64>(3)? != 0,
                locked: r.get::<_, i64>(4)? != 0,
            })
        })?;
        for row in rows {
            categories.push(row?);
        }
    }

    let mut history = Vec::new();
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT {CHANNEL}, h.time_pos, h.duration, h.watched_at, h.finished
               FROM watch_history h JOIN channels c ON c.id = h.channel_id ORDER BY h.watched_at DESC"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, f64>(3)?,
                r.get::<_, f64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)? != 0,
            ))
        })?;
        for row in rows {
            let (source, url, show, time_pos, duration, watched_at, finished) = row?;
            history.push(Watched { channel: reference(source, &url, show), time_pos, duration, watched_at, finished });
        }
    }

    let lock_words = super::lock_words_on(&conn)?;
    let meta = |key: &str| -> Result<Option<String>> {
        Ok(conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    };
    let epg_offset_minutes = meta(EPG_OFFSET_KEY)?.and_then(|v| v.parse().ok()).unwrap_or(0);
    let parental_pin = meta(crate::parental::META_KEY)?.filter(|v| !v.is_empty());

    Ok(Backup {
        app: "Tenvy".into(),
        format: FORMAT,
        version: version.into(),
        created_at: chrono::Utc::now().timestamp(),
        sources,
        favorites,
        hidden_channels,
        categories,
        history,
        lock_words,
        epg_offset_minutes,
        parental_pin,
        settings,
    })
}

// ---------- restore ----------

/// Read and check a backup file's contents.
pub fn parse(bytes: &[u8]) -> Result<Backup> {
    let backup: Backup = serde_json::from_slice(bytes).map_err(|_| err!("That isn't a Tenvy backup file."))?;
    if backup.app != "Tenvy" {
        return Err(err!("That isn't a Tenvy backup file."));
    }
    if backup.format > FORMAT {
        return Err(err!("This backup is from a newer Tenvy ({}). Update Tenvy first.", backup.version));
    }
    Ok(backup)
}

/// The local source for each source in the backup that's already here
/// (same kind, address and login), by the backup's `ref`.
pub fn match_sources(db: &Db, backup: &Backup) -> Result<HashMap<i64, i64>> {
    let conn = db.read();
    let mut found = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT id FROM sources WHERE kind = ?1 AND url = ?2 AND COALESCE(username, '') = COALESCE(?3, '') ORDER BY id LIMIT 1",
    )?;
    for s in &backup.sources {
        if let Some(id) = stmt.query_row(params![s.kind, s.url, s.username], |r| r.get::<_, i64>(0)).optional()? {
            found.insert(s.r#ref, id);
        }
    }
    Ok(found)
}

/// Top-level rows of a source by key (first row wins for duplicates).
fn top_level(conn: &Connection, source_id: i64) -> Result<HashMap<String, i64>> {
    let (kind, url): (String, String) =
        conn.query_row("SELECT kind, url FROM sources WHERE id = ?1", [source_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let ids = xtream_ids(&kind, &url);
    let mut stmt = conn.prepare("SELECT id, stream_url FROM channels WHERE source_id = ?1 AND parent_id IS NULL ORDER BY id")?;
    let mut map = HashMap::new();
    for row in stmt.query_map([source_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (id, url) = row?;
        map.entry(channel_key(&url, ids)).or_insert(id);
    }
    Ok(map)
}

fn episodes(conn: &Connection, show_id: i64) -> Result<HashMap<String, i64>> {
    let mut stmt = conn.prepare("SELECT id, stream_url FROM channels WHERE parent_id = ?1 ORDER BY id")?;
    let mut map = HashMap::new();
    for row in stmt.query_map([show_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (id, url) = row?;
        map.entry(channel_key(&url, true)).or_insert(id);
    }
    Ok(map)
}

/// `map[key]`, loaded the first time it's asked for.
fn cached<V>(map: &mut HashMap<i64, V>, key: i64, load: impl FnOnce() -> Result<V>) -> Result<&V> {
    Ok(match map.entry(key) {
        std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
        std::collections::hash_map::Entry::Vacant(e) => e.insert(load()?),
    })
}

fn all_refs(backup: &Backup) -> impl Iterator<Item = &ChannelRef> {
    backup
        .favorites
        .iter()
        .map(|f| &f.channel)
        .chain(backup.hidden_channels.iter())
        .chain(backup.history.iter().map(|h| &h.channel))
}

/// Shows (local ids) with episodes in the backup but none stored here
/// yet: their episodes need fetching before `apply` can match them.
pub fn shows_to_fetch(db: &Db, backup: &Backup, sources: &HashMap<i64, i64>) -> Result<Vec<i64>> {
    let conn = db.read();
    let mut tops: HashMap<i64, HashMap<String, i64>> = HashMap::new();
    let mut shows = Vec::new();
    for r in all_refs(backup) {
        let (Some(show), Some(&sid)) = (&r.show, sources.get(&r.source)) else { continue };
        let Some(&show_id) = cached(&mut tops, sid, || top_level(&conn, sid))?.get(show) else { continue };
        if !shows.contains(&show_id) && episodes(&conn, show_id)?.is_empty() {
            shows.push(show_id);
        }
    }
    Ok(shows)
}

/// Bring the backup's choices in, matched by key. Only adds.
pub fn apply(db: &Db, backup: &Backup, sources: &HashMap<i64, i64>, report: &mut RestoreReport) -> Result<()> {
    let mut conn = db.write();
    let tx = conn.transaction()?;
    {
        let mut tops: HashMap<i64, HashMap<String, i64>> = HashMap::new();
        let mut eps: HashMap<i64, HashMap<String, i64>> = HashMap::new();
        let mut resolve = |r: &ChannelRef| -> Result<Option<i64>> {
            let Some(&sid) = sources.get(&r.source) else { return Ok(None) };
            let top = cached(&mut tops, sid, || top_level(&tx, sid))?;
            match &r.show {
                None => Ok(top.get(&r.key).copied()),
                Some(show) => {
                    let Some(&show_id) = top.get(show) else { return Ok(None) };
                    Ok(cached(&mut eps, show_id, || episodes(&tx, show_id))?.get(&r.key).copied())
                }
            }
        };

        // Favorites go after the ones already here, in the backup's order.
        let base: i64 = tx.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM favorites", [], |r| r.get(0))?;
        let now = chrono::Utc::now().timestamp();
        let mut favs = backup.favorites.clone();
        favs.sort_by_key(|f| f.position);
        for (i, f) in favs.iter().enumerate() {
            match resolve(&f.channel)? {
                Some(id) => {
                    report.favorites += tx.execute(
                        "INSERT OR IGNORE INTO favorites (channel_id, added_at, position) VALUES (?1, ?2, ?3)",
                        params![id, now, base + i as i64],
                    )?;
                }
                None => report.not_found += 1,
            }
        }

        for r in &backup.hidden_channels {
            match resolve(r)? {
                Some(id) => {
                    report.hidden_channels +=
                        tx.execute("INSERT OR IGNORE INTO hidden_channels (channel_id) VALUES (?1)", [id])?
                }
                None => report.not_found += 1,
            }
        }

        // The newer of the two positions wins.
        for h in &backup.history {
            match resolve(&h.channel)? {
                Some(id) => {
                    report.history += tx.execute(
                        "INSERT INTO watch_history (channel_id, time_pos, duration, watched_at, finished)
                         VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT (channel_id) DO UPDATE SET
                           time_pos = excluded.time_pos, duration = excluded.duration,
                           watched_at = excluded.watched_at, finished = excluded.finished
                         WHERE excluded.watched_at > watch_history.watched_at",
                        params![id, h.time_pos, h.duration, h.watched_at, h.finished as i64],
                    )?;
                }
                None => report.not_found += 1,
            }
        }
    }

    // Hidden or locked here or there: stays hidden or locked.
    for c in &backup.categories {
        let Some(&sid) = sources.get(&c.source) else { continue };
        report.categories += tx.execute(
            "INSERT INTO group_prefs (source_id, kind, name, hidden, locked) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (source_id, kind, name) DO UPDATE SET
               hidden = MAX(hidden, excluded.hidden), locked = MAX(locked, excluded.locked)",
            params![sid, c.kind, c.name, c.hidden as i64, c.locked as i64],
        )?;
    }

    for w in &backup.lock_words {
        let w = super::fold(w.trim());
        if !w.is_empty() {
            tx.execute("INSERT OR IGNORE INTO lock_words (word) VALUES (?1)", [w])?;
        }
    }
    tx.commit()?;
    drop(conn);

    if backup.epg_offset_minutes != 0 && super::epg_offset_minutes(db)? == 0 {
        super::set_epg_offset_minutes(db, backup.epg_offset_minutes.clamp(-12 * 60, 12 * 60))?;
    }
    report.settings = backup.settings.clone();
    Ok(())
}
