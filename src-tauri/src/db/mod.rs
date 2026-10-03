use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;
use crate::models::{Channel, Group, HistoryEntry, HistoryProgress, Programme, Source, SourceKind};

const SCHEMA_SQL: &str = include_str!("schema.sql");

/// Shared connection handle. Rusqlite's Connection is not Sync, so we wrap in a
/// std::sync::Mutex and always do DB work on a blocking thread.
pub type Db = Arc<Mutex<Connection>>;

pub fn open(path: &Path) -> Result<Db> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA_SQL)?;
    migrate(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

/// Lightweight column-level migrations. SQLite has no `ADD COLUMN IF NOT
/// EXISTS`, so we introspect `PRAGMA table_info` and apply missing columns.
fn migrate(conn: &Connection) -> Result<()> {
    if !column_exists(conn, "channels", "kind")? {
        conn.execute(
            "ALTER TABLE channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'live'",
            [],
        )?;
    }
    // Always create the index — safe on both fresh and migrated DBs.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_channels_kind ON channels(source_id, kind, group_name)",
        [],
    )?;
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, col: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>("name"))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(names.iter().any(|n| n == col))
}

fn row_to_source(row: &rusqlite::Row) -> rusqlite::Result<Source> {
    let kind: String = row.get("kind")?;
    Ok(Source {
        id: row.get("id")?,
        kind: SourceKind::from_str(&kind).unwrap_or(SourceKind::M3u),
        name: row.get("name")?,
        url: row.get("url")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_channel(row: &rusqlite::Row) -> rusqlite::Result<Channel> {
    Ok(Channel {
        id: row.get("id")?,
        source_id: row.get("source_id")?,
        tvg_id: row.get("tvg_id")?,
        name: row.get("name")?,
        logo: row.get("logo")?,
        group: row.get("group_name")?,
        stream_url: row.get("stream_url")?,
        sort_order: row.get("sort_order")?,
        kind: row.get("kind")?,
    })
}

// ---------- sources ----------

pub fn list_sources(db: &Db) -> Result<Vec<Source>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id, kind, name, url, updated_at FROM sources ORDER BY id")?;
    let rows = stmt
        .query_map([], row_to_source)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_source(db: &Db, id: i64) -> Result<Option<Source>> {
    let conn = db.lock().unwrap();
    let row = conn
        .query_row(
            "SELECT id, kind, name, url, updated_at FROM sources WHERE id = ?1",
            [id],
            row_to_source,
        )
        .optional()?;
    Ok(row)
}

pub fn get_source_credentials(db: &Db, id: i64) -> Result<(Source, Option<String>, Option<String>)> {
    let conn = db.lock().unwrap();
    let row = conn.query_row(
        "SELECT id, kind, name, url, updated_at, username, password FROM sources WHERE id = ?1",
        [id],
        |r| {
            let kind: String = r.get("kind")?;
            let src = Source {
                id: r.get("id")?,
                kind: SourceKind::from_str(&kind).unwrap_or(SourceKind::M3u),
                name: r.get("name")?,
                url: r.get("url")?,
                updated_at: r.get("updated_at")?,
            };
            let u: Option<String> = r.get("username")?;
            let p: Option<String> = r.get("password")?;
            Ok((src, u, p))
        },
    )?;
    Ok(row)
}

pub fn insert_source(
    db: &Db,
    kind: &SourceKind,
    name: &str,
    url: &str,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO sources(kind, name, url, username, password, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))",
        params![kind.as_str(), name, url, username, password],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete_source(db: &Db, id: i64) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM sources WHERE id = ?1", [id])?;
    Ok(())
}

pub fn touch_source(db: &Db, id: i64) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE sources SET updated_at = strftime('%s','now') WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

// ---------- channels ----------

/// Wholesale replace every channel for a source. Called from ingestion.
pub fn replace_channels(db: &Db, source_id: i64, channels: &[ChannelInsert]) -> Result<usize> {
    let mut conn = db.lock().unwrap();
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM channels WHERE source_id = ?1", [source_id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO channels(source_id, tvg_id, name, logo, group_name, stream_url, sort_order, kind)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for (i, c) in channels.iter().enumerate() {
            stmt.execute(params![
                source_id,
                c.tvg_id,
                c.name,
                c.logo,
                c.group,
                c.stream_url,
                i as i64,
                c.kind,
            ])?;
        }
    }
    tx.commit()?;
    Ok(channels.len())
}

pub struct ChannelInsert {
    pub tvg_id: Option<String>,
    pub name: String,
    pub logo: Option<String>,
    pub group: Option<String>,
    pub stream_url: String,
    pub kind: String, // "live" | "movie" | "series"
}

pub fn list_groups(
    db: &Db,
    source_id: Option<i64>,
    kind: Option<&str>,
) -> Result<Vec<Group>> {
    let conn = db.lock().unwrap();
    // ORDER BY MIN(sort_order): the earliest channel in each group wins,
    // which means groups come out in the order the provider shipped them
    // (an M3U's `group-title=` sequence, or an Xtream `get_categories`
    // response). This is the same "relevance" order TiviMate uses — it's
    // curated by the provider, not alphabetical. Callers that want A–Z can
    // re-sort on the frontend.
    let mut sql = String::from(
        "SELECT COALESCE(group_name,'') AS g, COUNT(*) AS n, MIN(sort_order) AS ord \
         FROM channels WHERE 1=1",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(sid) = source_id {
        sql.push_str(" AND source_id = ?");
        args.push(Box::new(sid));
    }
    if let Some(k) = kind {
        sql.push_str(" AND kind = ?");
        args.push(Box::new(k.to_string()));
    }
    sql.push_str(" GROUP BY group_name ORDER BY ord");

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(refs.as_slice(), |r| {
            let name: String = r.get("g")?;
            let count: i64 = r.get("n")?;
            Ok(Group {
                name: if name.is_empty() { "Uncategorized".into() } else { name },
                count,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_channels(
    db: &Db,
    source_id: Option<i64>,
    group: Option<&str>,
    kind: Option<&str>,
) -> Result<Vec<Channel>> {
    let conn = db.lock().unwrap();
    let mut sql = String::from(
        "SELECT id, source_id, tvg_id, name, logo, group_name, stream_url, sort_order, kind
           FROM channels WHERE 1=1",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(sid) = source_id {
        sql.push_str(" AND source_id = ?");
        args.push(Box::new(sid));
    }
    if let Some(k) = kind {
        sql.push_str(" AND kind = ?");
        args.push(Box::new(k.to_string()));
    }
    match group {
        Some("Uncategorized") => sql.push_str(" AND (group_name IS NULL OR group_name = '')"),
        Some(g) => {
            sql.push_str(" AND group_name = ?");
            args.push(Box::new(g.to_string()));
        }
        None => {}
    }
    sql.push_str(" ORDER BY sort_order LIMIT 20000");

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(refs.as_slice(), row_to_channel)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Look up a single channel by primary key. Used by the track probe path
/// where we need a channel's `stream_url` and `kind` after the user clicks
/// something specific.
pub fn get_channel(db: &Db, id: i64) -> Result<Option<Channel>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, source_id, tvg_id, name, logo, group_name, stream_url, sort_order, kind
           FROM channels WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map([id], row_to_channel)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

pub fn search_channels(db: &Db, q: &str, kind: Option<&str>) -> Result<Vec<Channel>> {
    let conn = db.lock().unwrap();
    let like = format!("%{}%", q);
    let mut sql = String::from(
        "SELECT id, source_id, tvg_id, name, logo, group_name, stream_url, sort_order, kind
           FROM channels WHERE name LIKE ?1 COLLATE NOCASE",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(like)];
    if let Some(k) = kind {
        sql.push_str(" AND kind = ?");
        args.push(Box::new(k.to_string()));
    }
    sql.push_str(" ORDER BY sort_order LIMIT 500");

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(refs.as_slice(), row_to_channel)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ---------- favorites ----------

pub fn list_favorites(db: &Db) -> Result<Vec<Channel>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.source_id, c.tvg_id, c.name, c.logo, c.group_name, c.stream_url, c.sort_order, c.kind
           FROM favorites f JOIN channels c ON c.id = f.channel_id
           ORDER BY f.added_at DESC",
    )?;
    let rows = stmt
        .query_map([], row_to_channel)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn toggle_favorite(db: &Db, channel_id: i64) -> Result<bool> {
    let conn = db.lock().unwrap();
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM favorites WHERE channel_id = ?1",
            [channel_id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        conn.execute("DELETE FROM favorites WHERE channel_id = ?1", [channel_id])?;
        Ok(false)
    } else {
        conn.execute(
            "INSERT INTO favorites(channel_id, added_at) VALUES (?1, strftime('%s','now'))",
            [channel_id],
        )?;
        Ok(true)
    }
}

// ---------- watch history ----------

/// Upsert the user's position inside a channel. Called on every progress
/// tick from the frontend (throttled to ~once every few seconds there) —
/// a second watch of the same item overwrites the previous row rather
/// than growing the table. `finished` is a sticky bit: once a movie or
/// episode has been watched to the end, re-opening from the beginning
/// shouldn't clear it.
pub fn upsert_watch_progress(
    db: &Db,
    channel_id: i64,
    time_pos: f64,
    duration: f64,
    finished: bool,
) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO watch_history(channel_id, time_pos, duration, watched_at, finished)
         VALUES (?1, ?2, ?3, strftime('%s','now'), ?4)
         ON CONFLICT(channel_id) DO UPDATE SET
             time_pos   = excluded.time_pos,
             duration   = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE watch_history.duration END,
             watched_at = excluded.watched_at,
             finished   = CASE WHEN excluded.finished = 1 OR watch_history.finished = 1 THEN 1 ELSE 0 END",
        params![channel_id, time_pos, duration, if finished { 1 } else { 0 }],
    )?;
    Ok(())
}

pub fn list_watch_history(db: &Db) -> Result<Vec<HistoryEntry>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.source_id, c.tvg_id, c.name, c.logo, c.group_name, c.stream_url, c.sort_order, c.kind,
                h.time_pos, h.duration, h.watched_at, h.finished
           FROM watch_history h JOIN channels c ON c.id = h.channel_id
           ORDER BY h.watched_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(HistoryEntry {
                channel: row_to_channel(r)?,
                time_pos: r.get("time_pos")?,
                duration: r.get("duration")?,
                watched_at: r.get("watched_at")?,
                finished: r.get::<_, i64>("finished")? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Bulk-load progress rows without the joined channel data. The frontend
/// keeps these in a map so channel rows can cheaply look up whether they
/// have a progress bar to draw.
pub fn list_history_progress(db: &Db) -> Result<Vec<HistoryProgress>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT channel_id, time_pos, duration, watched_at, finished
           FROM watch_history",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(HistoryProgress {
                channel_id: r.get("channel_id")?,
                time_pos: r.get("time_pos")?,
                duration: r.get("duration")?,
                watched_at: r.get("watched_at")?,
                finished: r.get::<_, i64>("finished")? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_watch_entry(db: &Db, channel_id: i64) -> Result<Option<HistoryProgress>> {
    let conn = db.lock().unwrap();
    let row = conn
        .query_row(
            "SELECT channel_id, time_pos, duration, watched_at, finished
               FROM watch_history WHERE channel_id = ?1",
            [channel_id],
            |r| {
                Ok(HistoryProgress {
                    channel_id: r.get("channel_id")?,
                    time_pos: r.get("time_pos")?,
                    duration: r.get("duration")?,
                    watched_at: r.get("watched_at")?,
                    finished: r.get::<_, i64>("finished")? != 0,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn remove_watch_entry(db: &Db, channel_id: i64) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM watch_history WHERE channel_id = ?1", [channel_id])?;
    Ok(())
}

pub fn clear_watch_history(db: &Db) -> Result<()> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM watch_history", [])?;
    Ok(())
}

// ---------- programmes ----------

pub fn upsert_programmes(db: &Db, items: &[Programme]) -> Result<usize> {
    let mut conn = db.lock().unwrap();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO programmes(channel_tvg_id, start, stop, title, description)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(channel_tvg_id, start) DO UPDATE SET
                stop = excluded.stop,
                title = excluded.title,
                description = excluded.description",
        )?;
        for p in items {
            stmt.execute(params![p.channel_tvg_id, p.start, p.stop, p.title, p.description])?;
        }
    }
    tx.commit()?;
    Ok(items.len())
}

pub fn programmes_for_channels(
    db: &Db,
    tvg_ids: &[String],
    from: i64,
    to: i64,
) -> Result<Vec<Programme>> {
    if tvg_ids.is_empty() {
        return Ok(vec![]);
    }
    let conn = db.lock().unwrap();
    let placeholders = std::iter::repeat("?").take(tvg_ids.len()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT channel_tvg_id, start, stop, title, description
           FROM programmes
          WHERE channel_tvg_id IN ({}) AND stop > ? AND start < ?
          ORDER BY channel_tvg_id, start",
        placeholders
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut args: Vec<&dyn rusqlite::ToSql> = tvg_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let from_box: Box<dyn rusqlite::ToSql> = Box::new(from);
    let to_box: Box<dyn rusqlite::ToSql> = Box::new(to);
    args.push(from_box.as_ref());
    args.push(to_box.as_ref());
    let rows = stmt
        .query_map(args.as_slice(), |r| {
            Ok(Programme {
                channel_tvg_id: r.get("channel_tvg_id")?,
                start: r.get("start")?,
                stop: r.get("stop")?,
                title: r.get("title")?,
                description: r.get("description")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn current_programme(db: &Db, tvg_id: &str) -> Result<Option<Programme>> {
    let conn = db.lock().unwrap();
    let row = conn
        .query_row(
            "SELECT channel_tvg_id, start, stop, title, description
               FROM programmes
              WHERE channel_tvg_id = ?1 AND start <= strftime('%s','now') AND stop > strftime('%s','now')
              LIMIT 1",
            [tvg_id],
            |r| {
                Ok(Programme {
                    channel_tvg_id: r.get("channel_tvg_id")?,
                    start: r.get("start")?,
                    stop: r.get("stop")?,
                    title: r.get("title")?,
                    description: r.get("description")?,
                })
            },
        )
        .optional()?;
    Ok(row)
}
