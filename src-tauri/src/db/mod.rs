use std::collections::{HashMap, VecDeque};
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
    // Xtream series support: a show is a `container` row whose episodes
    // are child rows (`parent_id`) fetched on demand.
    for (col, ddl) in [
        ("container", "ALTER TABLE channels ADD COLUMN container INTEGER NOT NULL DEFAULT 0"),
        ("parent_id", "ALTER TABLE channels ADD COLUMN parent_id INTEGER REFERENCES channels(id) ON DELETE CASCADE"),
        ("season", "ALTER TABLE channels ADD COLUMN season INTEGER"),
        ("episode", "ALTER TABLE channels ADD COLUMN episode INTEGER"),
    ] {
        if !column_exists(conn, "channels", col)? {
            conn.execute(ddl, [])?;
        }
    }
    // Always create the indexes — safe on both fresh and migrated DBs.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_channels_kind ON channels(source_id, kind, group_name);
         CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_id);",
    )?;
    Ok(())
}

/// Column list for `row_to_channel`, against a table aliased `c`.
const CHANNEL_COLS: &str = "c.id, c.source_id, c.tvg_id, c.name, c.logo, c.group_name, c.stream_url, \
     c.sort_order, c.kind, c.container, c.parent_id, c.season, c.episode";

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
        container: row.get::<_, i64>("container")? != 0,
        parent_id: row.get("parent_id")?,
        season: row.get("season")?,
        episode: row.get("episode")?,
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

/// Sync a source's top-level channel rows with a freshly ingested list.
///
/// Rows are matched on `channel_key` and updated in place so their ids —
/// and therefore favorites and watch history, which hang off `channels.id`
/// with ON DELETE CASCADE — survive a refresh. Only channels that are no
/// longer in the playlist are deleted. Episode rows (`parent_id` set) are
/// left alone; they belong to their show and go when it goes.
pub fn replace_channels(db: &Db, source_id: i64, channels: &[ChannelInsert]) -> Result<usize> {
    let mut conn = db.lock().unwrap();
    let tx = conn.transaction()?;
    sync_rows(&tx, source_id, None, None, channels)?;
    tx.commit()?;
    Ok(channels.len())
}

/// Sync the episode rows under one series container (same id-preserving
/// rules as `replace_channels`). Returns the stored episodes in order.
pub fn replace_episodes(db: &Db, parent_id: i64, episodes: &[ChannelInsert]) -> Result<Vec<Channel>> {
    {
        let mut conn = db.lock().unwrap();
        let tx = conn.transaction()?;
        let (source_id, group): (i64, Option<String>) = tx.query_row(
            "SELECT source_id, group_name FROM channels WHERE id = ?1",
            [parent_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        sync_rows(&tx, source_id, Some(parent_id), group.as_deref(), episodes)?;
        tx.commit()?;
    }
    list_episodes(db, parent_id)
}

pub fn list_episodes(db: &Db, parent_id: i64) -> Result<Vec<Channel>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHANNEL_COLS} FROM channels c WHERE c.parent_id = ?1 ORDER BY c.sort_order"
    ))?;
    let rows = stmt
        .query_map([parent_id], row_to_channel)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The shared update-in-place / insert / delete-vanished algorithm, scoped
/// to one source and one parent (None = top-level rows). Duplicate keys
/// (the same stream listed under two groups) pair up with existing rows in
/// id order. `group` overrides each item's group (episodes inherit the
/// show's).
fn sync_rows(
    tx: &rusqlite::Transaction,
    source_id: i64,
    parent_id: Option<i64>,
    group: Option<&str>,
    items: &[ChannelInsert],
) -> Result<()> {
    let mut existing: HashMap<String, VecDeque<i64>> = HashMap::new();
    {
        let mut stmt = tx.prepare(
            "SELECT id, stream_url FROM channels WHERE source_id = ?1 AND parent_id IS ?2 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![source_id, parent_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, url) = row?;
            existing.entry(channel_key(&url)).or_default().push_back(id);
        }
    }

    {
        let mut update = tx.prepare(
            "UPDATE channels
                SET tvg_id = ?2, name = ?3, logo = ?4, group_name = ?5, stream_url = ?6,
                    sort_order = ?7, kind = ?8, container = ?9, season = ?10, episode = ?11
              WHERE id = ?1",
        )?;
        let mut insert = tx.prepare(
            "INSERT INTO channels(source_id, parent_id, tvg_id, name, logo, group_name, stream_url,
                                  sort_order, kind, container, season, episode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )?;
        for (i, c) in items.iter().enumerate() {
            let group = group.or(c.group.as_deref());
            let reuse = existing
                .get_mut(&channel_key(&c.stream_url))
                .and_then(|ids| ids.pop_front());
            match reuse {
                Some(id) => {
                    update.execute(params![
                        id, c.tvg_id, c.name, c.logo, group, c.stream_url, i as i64, c.kind,
                        c.container, c.season, c.episode,
                    ])?;
                }
                None => {
                    insert.execute(params![
                        source_id, parent_id, c.tvg_id, c.name, c.logo, group, c.stream_url,
                        i as i64, c.kind, c.container, c.season, c.episode,
                    ])?;
                }
            }
        }
    }

    let mut delete = tx.prepare("DELETE FROM channels WHERE id = ?1")?;
    for id in existing.into_values().flatten() {
        delete.execute([id])?;
    }
    Ok(())
}

/// Identity of a channel across refreshes. Xtream URLs embed the account's
/// host, username and password, any of which can change (providers rotate
/// DNS, users reset passwords) without the stream itself changing — so for
/// those we key on `{kind}/{stream_id}`. Everything else keys on the URL.
fn channel_key(stream_url: &str) -> String {
    match crate::sources::xtream::parse_xtream_url(stream_url) {
        Some(x) => format!("xtream:{}/{}", x.kind, x.stream_id),
        None => stream_url.to_string(),
    }
}

#[derive(Debug, Default)]
pub struct ChannelInsert {
    pub tvg_id: Option<String>,
    pub name: String,
    pub logo: Option<String>,
    pub group: Option<String>,
    pub stream_url: String,
    pub kind: String, // "live" | "movie" | "series"
    /// A series whose episodes are fetched on demand (Xtream).
    pub container: bool,
    pub season: Option<i64>,
    pub episode: Option<i64>,
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
    // re-sort on the frontend. NULL and '' both mean "Uncategorized", so
    // group on the coalesced value to get one row for them.
    let mut sql = String::from(
        "SELECT COALESCE(group_name,'') AS g, COUNT(*) AS n, MIN(sort_order) AS ord \
         FROM channels WHERE parent_id IS NULL",
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
    sql.push_str(" GROUP BY g ORDER BY ord");

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
    let mut sql = format!("SELECT {CHANNEL_COLS} FROM channels c WHERE c.parent_id IS NULL");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(sid) = source_id {
        sql.push_str(" AND c.source_id = ?");
        args.push(Box::new(sid));
    }
    if let Some(k) = kind {
        sql.push_str(" AND c.kind = ?");
        args.push(Box::new(k.to_string()));
    }
    match group {
        Some("Uncategorized") => sql.push_str(" AND (c.group_name IS NULL OR c.group_name = '')"),
        Some(g) => {
            sql.push_str(" AND c.group_name = ?");
            args.push(Box::new(g.to_string()));
        }
        None => {}
    }
    sql.push_str(" ORDER BY c.sort_order LIMIT 50000");

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(refs.as_slice(), row_to_channel)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_channel(db: &Db, id: i64) -> Result<Option<Channel>> {
    let conn = db.lock().unwrap();
    let row = conn
        .query_row(
            &format!("SELECT {CHANNEL_COLS} FROM channels c WHERE c.id = ?1"),
            [id],
            row_to_channel,
        )
        .optional()?;
    Ok(row)
}

/// Case-insensitive substring search over every top-level channel, movie
/// and show — across all groups, not just the one on screen.
pub fn search_channels(
    db: &Db,
    q: &str,
    source_id: Option<i64>,
    kind: Option<&str>,
) -> Result<Vec<Channel>> {
    let conn = db.lock().unwrap();
    // Escape LIKE wildcards so a search for "100%" means the literal text.
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let mut sql = format!(
        "SELECT {CHANNEL_COLS} FROM channels c
          WHERE c.parent_id IS NULL AND c.name LIKE ? ESCAPE '\\' COLLATE NOCASE"
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(format!("%{}%", escaped))];
    if let Some(sid) = source_id {
        sql.push_str(" AND c.source_id = ?");
        args.push(Box::new(sid));
    }
    if let Some(k) = kind {
        sql.push_str(" AND c.kind = ?");
        args.push(Box::new(k.to_string()));
    }
    // Prefix matches first, then provider order.
    sql.push_str(" ORDER BY (c.name LIKE ? ESCAPE '\\' COLLATE NOCASE) DESC, c.sort_order LIMIT 200");
    args.push(Box::new(format!("{}%", escaped)));

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
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHANNEL_COLS}
           FROM favorites f JOIN channels c ON c.id = f.channel_id
           ORDER BY f.added_at DESC"
    ))?;
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
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHANNEL_COLS}, h.time_pos, h.duration, h.watched_at, h.finished
           FROM watch_history h JOIN channels c ON c.id = h.channel_id
           ORDER BY h.watched_at DESC"
    ))?;
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
    // Programmes are only ever upserted, so without pruning every XMLTV
    // refresh grows the table forever. The guide shows at most a couple of
    // hours of the past; keep a day for slack.
    tx.execute(
        "DELETE FROM programmes WHERE stop < strftime('%s','now') - 86400",
        [],
    )?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        migrate(&conn).unwrap();
        Arc::new(Mutex::new(conn))
    }

    fn ch(name: &str, url: &str) -> ChannelInsert {
        ChannelInsert {
            tvg_id: None,
            name: name.into(),
            logo: None,
            group: Some("G".into()),
            stream_url: url.into(),
            kind: "live".into(),
            ..Default::default()
        }
    }

    #[test]
    fn episodes_live_under_their_show() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::Xtream, "s", "http://h", None, None).unwrap();
        let show = ChannelInsert {
            kind: "series".into(),
            container: true,
            ..ch("Show", "http://h/series/u/p/9")
        };
        replace_channels(&db, sid, &[show]).unwrap();
        let show_id = id_of(&db, "Show");

        let ep = |n: i64| ChannelInsert {
            kind: "series".into(),
            season: Some(1),
            episode: Some(n),
            ..ch(&format!("E{n}"), &format!("http://h/series/u/p/{}.mkv", 100 + n))
        };
        let eps = replace_episodes(&db, show_id, &[ep(1), ep(2)]).unwrap();
        assert_eq!(eps.len(), 2);
        assert_eq!(eps[0].parent_id, Some(show_id));
        assert_eq!(eps[1].episode, Some(2));
        upsert_watch_progress(&db, eps[0].id, 50.0, 100.0, false).unwrap();

        // Episodes don't show up as top-level rows, and a playlist refresh
        // that still contains the show leaves them (and history) intact.
        assert_eq!(list_channels(&db, Some(sid), None, None).unwrap().len(), 1);
        let show_again = ChannelInsert { kind: "series".into(), container: true, ..ch("Show", "http://h/series/u/p/9") };
        replace_channels(&db, sid, &[show_again]).unwrap();
        assert_eq!(list_episodes(&db, show_id).unwrap().len(), 2);
        assert!(get_watch_entry(&db, eps[0].id).unwrap().is_some());

        // The show disappearing takes its episodes with it.
        replace_channels(&db, sid, &[]).unwrap();
        assert!(list_episodes(&db, show_id).unwrap().is_empty());
    }

    fn id_of(db: &Db, name: &str) -> i64 {
        db.lock()
            .unwrap()
            .query_row("SELECT id FROM channels WHERE name = ?1", [name], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn refresh_keeps_favorites_and_history() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        replace_channels(&db, sid, &[ch("A", "http://h/a"), ch("B", "http://h/b")]).unwrap();
        let a = id_of(&db, "A");
        toggle_favorite(&db, a).unwrap();
        upsert_watch_progress(&db, a, 100.0, 1000.0, false).unwrap();

        // Refresh: A renamed and moved, B dropped, C added.
        replace_channels(&db, sid, &[ch("C", "http://h/c"), ch("A2", "http://h/a")]).unwrap();

        assert_eq!(id_of(&db, "A2"), a, "existing channel keeps its id");
        assert_eq!(list_favorites(&db).unwrap().len(), 1);
        assert!(get_watch_entry(&db, a).unwrap().is_some());
        let names: Vec<String> = list_channels(&db, Some(sid), None, None)
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["C", "A2"]);
    }

    #[test]
    fn xtream_identity_survives_credential_change() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        replace_channels(&db, sid, &[ch("M", "http://old.host/movie/u/oldpw/42.mkv")]).unwrap();
        let m = id_of(&db, "M");
        toggle_favorite(&db, m).unwrap();

        replace_channels(&db, sid, &[ch("M", "http://new.host:8080/movie/u/newpw/42.mkv")]).unwrap();

        assert_eq!(id_of(&db, "M"), m);
        assert_eq!(list_favorites(&db).unwrap()[0].stream_url, "http://new.host:8080/movie/u/newpw/42.mkv");
    }

    #[test]
    fn duplicate_urls_are_kept_as_separate_rows() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        let list = [ch("A", "http://h/a"), ch("A again", "http://h/a")];
        replace_channels(&db, sid, &list).unwrap();
        replace_channels(&db, sid, &list).unwrap();
        assert_eq!(list_channels(&db, Some(sid), None, None).unwrap().len(), 2);
    }
}
