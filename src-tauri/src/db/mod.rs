use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;
use crate::models::{
    Channel, Group, HistoryEntry, HistoryProgress, Programme, Reminder, Source, SourceKind, SourceStats,
};

const SCHEMA_SQL: &str = include_str!("schema.sql");

/// Shared database handle: one connection for writes and one for reads.
///
/// Rusqlite's Connection is not Sync, so each sits behind a std Mutex and
/// all DB work happens on blocking threads. In WAL mode readers never wait
/// for a writer, so splitting them keeps the UI's queries (channel lists,
/// now-playing lookups) responsive while a large guide import holds the
/// write connection for several seconds.
#[derive(Clone)]
pub struct Db {
    write: Arc<Mutex<Connection>>,
    read: Arc<Mutex<Connection>>,
}

impl Db {
    fn write(&self) -> MutexGuard<'_, Connection> {
        self.write.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn read(&self) -> MutexGuard<'_, Connection> {
        self.read.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn open(path: &Path) -> Result<Db> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let write = Connection::open(path)?;
    write.busy_timeout(Duration::from_secs(10))?;
    write.execute_batch(SCHEMA_SQL)?;
    migrate(&write)?;

    let read = Connection::open(path)?;
    read.busy_timeout(Duration::from_secs(10))?;
    read.execute_batch("PRAGMA query_only = ON; PRAGMA temp_store = MEMORY;")?;

    Ok(Db {
        write: Arc::new(Mutex::new(write)),
        read: Arc::new(Mutex::new(read)),
    })
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
        // Guide matching by name (see xmltv::channel_name_key).
        ("name_key", "ALTER TABLE channels ADD COLUMN name_key TEXT"),
        // Per-stream HTTP headers from #EXTVLCOPT or `url|User-Agent=…`.
        ("user_agent", "ALTER TABLE channels ADD COLUMN user_agent TEXT"),
        ("referrer", "ALTER TABLE channels ADD COLUMN referrer TEXT"),
        // Days of catch-up the provider keeps for a live channel (Xtream
        // tv_archive_duration); NULL = no catch-up.
        ("archive_days", "ALTER TABLE channels ADD COLUMN archive_days INTEGER"),
        // Library metadata for movies/series: rating out of 10, release
        // year, and when the provider added it (epoch seconds).
        ("rating", "ALTER TABLE channels ADD COLUMN rating REAL"),
        ("year", "ALTER TABLE channels ADD COLUMN year INTEGER"),
        ("added", "ALTER TABLE channels ADD COLUMN added INTEGER"),
    ] {
        if !column_exists(conn, "channels", col)? {
            conn.execute(ddl, [])?;
        }
    }
    // Always create the indexes — safe on both fresh and migrated DBs.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_channels_kind ON channels(source_id, kind, group_name);
         CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_id);
         CREATE TABLE IF NOT EXISTS reminders (
             channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
             start      INTEGER NOT NULL,
             stop       INTEGER NOT NULL,
             title      TEXT    NOT NULL,
             PRIMARY KEY (channel_id, start)
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS epg_channels (
             name_key TEXT NOT NULL,
             id       TEXT NOT NULL,
             PRIMARY KEY (name_key, id)
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS hidden_channels (
             channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS group_prefs (
             source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
             kind      TEXT    NOT NULL,
             name      TEXT    NOT NULL,
             hidden    INTEGER NOT NULL DEFAULT 0,
             locked    INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (source_id, kind, name)
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         ) WITHOUT ROWID;",
    )?;

    // Favorites in the viewer's own order; existing ones keep newest-first.
    if !column_exists(conn, "favorites", "position")? {
        conn.execute_batch(
            "ALTER TABLE favorites ADD COLUMN position INTEGER;
             UPDATE favorites SET position = (
                 SELECT COUNT(*) FROM favorites f2 WHERE f2.added_at > favorites.added_at
                    OR (f2.added_at = favorites.added_at AND f2.channel_id < favorites.channel_id));",
        )?;
    }

    // One-off data migrations, tracked with SQLite's user_version.
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        // Guide ids became case-insensitive (stored lowercase).
        conn.execute_batch(
            "BEGIN;
             UPDATE channels SET tvg_id = lower(tvg_id) WHERE tvg_id IS NOT NULL;
             UPDATE OR REPLACE programmes SET channel_tvg_id = lower(channel_tvg_id);
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
    }
    Ok(())
}

/// Column list for `row_to_channel`, against a table aliased `c`.
///
/// `tvg_id` is the channel's guide id: its own, or — when the playlist
/// didn't give one — the id of a guide channel with the same normalised
/// name.
const CHANNEL_COLS: &str = "c.id, c.source_id, \
     COALESCE(c.tvg_id, (SELECT e.id FROM epg_channels e WHERE e.name_key = c.name_key LIMIT 1)) AS tvg_id, \
     c.name, c.logo, c.group_name, c.stream_url, \
     c.sort_order, c.kind, c.container, c.parent_id, c.season, c.episode, c.archive_days, \
     c.rating, c.year, c.added";

/// SQL condition (on a channel aliased `c`) that leaves out rows in
/// categories the viewer hid (`skip_hidden`) or locked (while locked).
/// None when nothing needs leaving out.
/// Leaves out channels the viewer hid one by one (appended to a WHERE).
const HIDDEN_CHANNEL_FILTER: &str = " AND c.id NOT IN (SELECT channel_id FROM hidden_channels)";

fn visibility_clause(skip_hidden: bool, unlocked: bool) -> Option<String> {
    let cond = match (skip_hidden, unlocked) {
        (false, true) => return None,
        (true, true) => "gp.hidden = 1",
        (false, false) => "gp.locked = 1",
        (true, false) => "(gp.hidden = 1 OR gp.locked = 1)",
    };
    Some(format!(
        "NOT EXISTS (SELECT 1 FROM group_prefs gp WHERE gp.source_id = c.source_id AND gp.kind = c.kind \
           AND gp.name = COALESCE(NULLIF(c.group_name, ''), 'Uncategorized') AND {cond})"
    ))
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
        container: row.get::<_, i64>("container")? != 0,
        parent_id: row.get("parent_id")?,
        season: row.get("season")?,
        episode: row.get("episode")?,
        archive_days: row.get("archive_days")?,
        rating: row.get("rating")?,
        year: row.get("year")?,
        added: row.get("added")?,
    })
}

// ---------- sources ----------

pub fn list_sources(db: &Db) -> Result<Vec<Source>> {
    let conn = db.read();
    let mut stmt = conn.prepare("SELECT id, kind, name, url, updated_at FROM sources ORDER BY id")?;
    let rows = stmt
        .query_map([], row_to_source)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_source(db: &Db, id: i64) -> Result<Option<Source>> {
    let conn = db.read();
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
    let conn = db.read();
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
    let conn = db.write();
    conn.execute(
        "INSERT INTO sources(kind, name, url, username, password, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))",
        params![kind.as_str(), name, url, username, password],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_source(db: &Db, id: i64, name: &str) -> Result<()> {
    db.write().execute("UPDATE sources SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

/// Turn an M3U source that points at an Xtream panel's get.php into a
/// proper Xtream source. The API gives series as shows (not hundreds of
/// thousands of loose episodes), cleaner categories and library metadata.
pub fn convert_source_to_xtream(db: &Db, id: i64, host: &str, user: &str, pass: &str) -> Result<()> {
    let conn = db.write();
    conn.execute(
        "UPDATE sources SET kind = 'xtream', url = ?2, username = ?3, password = ?4 WHERE id = ?1",
        params![id, host, user, pass],
    )?;
    Ok(())
}

pub fn delete_source(db: &Db, id: i64) -> Result<()> {
    let conn = db.write();
    conn.execute("DELETE FROM sources WHERE id = ?1", [id])?;
    Ok(())
}

pub fn touch_source(db: &Db, id: i64) -> Result<()> {
    let conn = db.write();
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
///
/// `kinds` lists the content kinds this ingest is authoritative for; rows
/// of other kinds are left untouched. An Xtream import whose movie list
/// failed to download passes only `["live", "series"]`, so a provider
/// hiccup can't wipe every movie (and its favorites and resume points).
pub fn replace_channels(
    db: &Db,
    source_id: i64,
    kinds: &[&str],
    channels: &[ChannelInsert],
) -> Result<usize> {
    replace_channels_guarded(db, source_id, kinds, channels, true)
}

/// `replace_channels` with the mass-deletion guard optional — off only
/// for deliberate format changes (see `convert_source_to_xtream`), where
/// most rows legitimately change identity.
pub fn replace_channels_guarded(
    db: &Db,
    source_id: i64,
    kinds: &[&str],
    channels: &[ChannelInsert],
    guard: bool,
) -> Result<usize> {
    let mut conn = db.write();
    let tx = conn.transaction()?;
    let (kind, url): (String, String) = tx.query_row(
        "SELECT kind, url FROM sources WHERE id = ?1",
        [source_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // Xtream stream URLs can be keyed on their stream id (see
    // `channel_key`) — but only for sources that really are Xtream panels;
    // an ordinary M3U's paths can look the same by accident.
    let xtream_ids = kind == SourceKind::Xtream.as_str()
        || crate::sources::xtream::credentials_from_m3u_url(&url).is_some();
    sync_rows(&tx, source_id, None, Some(kinds), None, xtream_ids, guard, channels)?;
    tx.commit()?;
    Ok(channels.len())
}

/// Sync the episode rows under one series container (same id-preserving
/// rules as `replace_channels`). Returns the stored episodes in order.
pub fn replace_episodes(db: &Db, parent_id: i64, episodes: &[ChannelInsert]) -> Result<Vec<Channel>> {
    {
        let mut conn = db.write();
        let tx = conn.transaction()?;
        let (source_id, group): (i64, Option<String>) = tx.query_row(
            "SELECT source_id, group_name FROM channels WHERE id = ?1",
            [parent_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        sync_rows(&tx, source_id, Some(parent_id), None, group.as_deref(), true, true, episodes)?;
        tx.commit()?;
    }
    list_episodes(db, parent_id)
}

pub fn list_episodes(db: &Db, parent_id: i64) -> Result<Vec<Channel>> {
    let conn = db.read();
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
/// id order. `kinds` limits which existing rows are in scope (None = all);
/// `group` overrides each item's group (episodes inherit the show's).
///
/// Refuses (and so keeps the current rows) when the new list would delete
/// most of a sizeable existing one: that is far more likely a provider
/// returning a truncated or empty response than a real catalogue change,
/// and deletions cascade to favorites and watch history.
fn sync_rows(
    tx: &rusqlite::Transaction,
    source_id: i64,
    parent_id: Option<i64>,
    kinds: Option<&[&str]>,
    group: Option<&str>,
    xtream_ids: bool,
    guard: bool,
    items: &[ChannelInsert],
) -> Result<()> {
    let mut existing: HashMap<String, VecDeque<i64>> = HashMap::new();
    let mut existing_total = 0usize;
    {
        let mut sql = String::from(
            "SELECT id, stream_url FROM channels WHERE source_id = ? AND parent_id IS ?",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(source_id), Box::new(parent_id)];
        if let Some(kinds) = kinds {
            sql.push_str(&format!(" AND kind IN ({})", vec!["?"; kinds.len()].join(",")));
            args.extend(kinds.iter().map(|k| Box::new(k.to_string()) as Box<dyn rusqlite::ToSql>));
        }
        sql.push_str(" ORDER BY id");
        let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a.as_ref()).collect();
        let mut stmt = tx.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, url) = row?;
            existing.entry(channel_key(&url, xtream_ids)).or_default().push_back(id);
            existing_total += 1;
        }
    }

    // Count what would vanish before touching anything.
    {
        let mut unclaimed: HashMap<String, usize> =
            existing.iter().map(|(k, v)| (k.clone(), v.len())).collect();
        for c in items {
            if let Some(n) = unclaimed.get_mut(&channel_key(&c.stream_url, xtream_ids)) {
                *n = n.saturating_sub(1);
            }
        }
        let vanishing: usize = unclaimed.values().sum();
        if guard && existing_total >= MASS_DELETE_MIN_ROWS && vanishing * 10 > existing_total * 7 {
            return Err(crate::err!(
                "The provider returned only {} items where there were {} before. Keeping your                  current list — try refreshing again later, or remove and re-add the playlist                  if this change is expected.",
                items.len(),
                existing_total
            ));
        }
    }

    {
        let mut update = tx.prepare(
            "UPDATE channels
                SET tvg_id = ?2, name = ?3, logo = ?4, group_name = ?5, stream_url = ?6,
                    sort_order = ?7, kind = ?8, container = ?9, season = ?10, episode = ?11,
                    name_key = ?12, user_agent = ?13, referrer = ?14, archive_days = ?15,
                    rating = ?16, year = ?17, added = ?18
              WHERE id = ?1",
        )?;
        let mut insert = tx.prepare(
            "INSERT INTO channels(source_id, parent_id, tvg_id, name, logo, group_name, stream_url,
                                  sort_order, kind, container, season, episode,
                                  name_key, user_agent, referrer, archive_days, rating, year, added)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                     ?17, ?18, ?19)",
        )?;
        for (i, c) in items.iter().enumerate() {
            let group = group.or(c.group.as_deref());
            // Guide ids are matched case-insensitively; see xmltv::parse.
            let tvg_id = c.tvg_id.as_deref().map(str::to_lowercase);
            // Only live channels have guide data worth matching by name.
            let name_key = (c.kind == "live" && tvg_id.is_none())
                .then(|| crate::sources::xmltv::channel_name_key(&c.name))
                .filter(|k| !k.is_empty());
            let reuse = existing
                .get_mut(&channel_key(&c.stream_url, xtream_ids))
                .and_then(|ids| ids.pop_front());
            match reuse {
                Some(id) => {
                    update.execute(params![
                        id, tvg_id, c.name, c.logo, group, c.stream_url, i as i64, c.kind,
                        c.container, c.season, c.episode, name_key, c.user_agent, c.referrer,
                        c.archive_days, c.rating, c.year, c.added,
                    ])?;
                }
                None => {
                    insert.execute(params![
                        source_id, parent_id, tvg_id, c.name, c.logo, group, c.stream_url,
                        i as i64, c.kind, c.container, c.season, c.episode, name_key,
                        c.user_agent, c.referrer, c.archive_days, c.rating, c.year, c.added,
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
/// those we key on `{kind}/{stream_id}` when the source is an Xtream panel.
/// Everything else keys on the URL.
fn channel_key(stream_url: &str, xtream_ids: bool) -> String {
    match crate::sources::xtream::parse_xtream_url(stream_url).filter(|_| xtream_ids) {
        Some(x) => format!("xtream:{}/{}", x.kind, x.stream_id),
        None => stream_url.to_string(),
    }
}

/// Every content kind — for ingests (like M3U) that cover all of them.
pub const ALL_KINDS: &[&str] = &["live", "movie", "series"];

/// Below this many existing rows the mass-deletion guard in `sync_rows`
/// doesn't apply — small playlists legitimately change wholesale.
const MASS_DELETE_MIN_ROWS: usize = 200;

#[derive(Debug, Default, Clone)]
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
    /// HTTP headers the provider requires for this stream.
    pub user_agent: Option<String>,
    pub referrer: Option<String>,
    /// Days of catch-up available (live channels only).
    pub archive_days: Option<i64>,
    /// Movies/series: rating out of 10, release year, provider's added time.
    pub rating: Option<f64>,
    pub year: Option<i64>,
    pub added: Option<i64>,
}

/// What the player needs to open a channel.
pub struct Playback {
    pub stream_url: String,
    pub user_agent: Option<String>,
    pub referrer: Option<String>,
}

pub fn get_playback(db: &Db, channel_id: i64) -> Result<Option<Playback>> {
    let conn = db.read();
    let row = conn
        .query_row(
            "SELECT stream_url, user_agent, referrer FROM channels WHERE id = ?1",
            [channel_id],
            |r| {
                Ok(Playback {
                    stream_url: r.get(0)?,
                    user_agent: r.get(1)?,
                    referrer: r.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn list_groups(
    db: &Db,
    source_id: Option<i64>,
    kind: Option<&str>,
) -> Result<Vec<Group>> {
    let conn = db.read();
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
                hidden: false,
                locked: false,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Mark hidden / locked categories (any source, when showing all).
    let mut prefs: HashMap<String, (bool, bool)> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT name, MAX(hidden), MAX(locked) FROM group_prefs \
          WHERE (?1 IS NULL OR source_id = ?1) AND (?2 IS NULL OR kind = ?2) GROUP BY name",
    )?;
    for row in stmt.query_map(params![source_id, kind], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0, r.get::<_, i64>(2)? != 0))
    })? {
        let (name, hidden, locked) = row?;
        prefs.insert(name, (hidden, locked));
    }
    let rows = rows
        .into_iter()
        .map(|mut g| {
            if let Some((hidden, locked)) = prefs.get(&g.name) {
                g.hidden = *hidden;
                g.locked = *locked;
            }
            g
        })
        .collect();
    Ok(rows)
}

/// Hide/show or lock/unlock categories. `None` leaves that flag as is.
pub fn set_group_prefs(
    db: &Db,
    source_id: i64,
    kind: &str,
    names: &[String],
    hidden: Option<bool>,
    locked: Option<bool>,
) -> Result<()> {
    let mut conn = db.write();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO group_prefs (source_id, kind, name, hidden, locked)
             VALUES (?1, ?2, ?3, COALESCE(?4, 0), COALESCE(?5, 0))
             ON CONFLICT (source_id, kind, name) DO UPDATE SET
               hidden = COALESCE(?4, hidden), locked = COALESCE(?5, locked)",
        )?;
        for name in names {
            stmt.execute(params![source_id, kind, name, hidden, locked])?;
        }
    }
    tx.execute("DELETE FROM group_prefs WHERE hidden = 0 AND locked = 0", [])?;
    tx.commit()?;
    Ok(())
}

pub fn list_channels(
    db: &Db,
    source_id: Option<i64>,
    group: Option<&str>,
    kind: Option<&str>,
    unlocked: bool,
) -> Result<Vec<Channel>> {
    let conn = db.read();
    let mut sql = format!("SELECT {CHANNEL_COLS} FROM channels c WHERE c.parent_id IS NULL");
    // A category picked by name shows even if hidden (that's how it's
    // reviewed); "All" leaves hidden ones out. Locked ones need the PIN.
    if let Some(clause) = visibility_clause(group.is_none(), unlocked) {
        sql.push_str(" AND ");
        sql.push_str(&clause);
    }
    sql.push_str(HIDDEN_CHANNEL_FILTER);
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
    let conn = db.read();
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
    unlocked: bool,
) -> Result<Vec<Channel>> {
    let conn = db.read();
    // Escape LIKE wildcards so a search for "100%" means the literal text.
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let mut sql = format!(
        "SELECT {CHANNEL_COLS} FROM channels c
          WHERE c.parent_id IS NULL AND c.name LIKE ? ESCAPE '\\' COLLATE NOCASE"
    );
    if let Some(clause) = visibility_clause(true, unlocked) {
        sql.push_str(" AND ");
        sql.push_str(&clause);
    }
    sql.push_str(HIDDEN_CHANNEL_FILTER);
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

/// Newest movies or series by when the provider added them, for Home.
pub fn recently_added(db: &Db, kind: &str, limit: i64, unlocked: bool) -> Result<Vec<Channel>> {
    let conn = db.read();
    let filter = visibility_clause(true, unlocked).map(|c| format!("AND {c}")).unwrap_or_default();
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHANNEL_COLS} FROM channels c
          WHERE c.parent_id IS NULL AND c.kind = ?1 AND c.added IS NOT NULL {filter} {HIDDEN_CHANNEL_FILTER}
          ORDER BY c.added DESC LIMIT ?2"
    ))?;
    let rows = stmt
        .query_map(params![kind, limit], row_to_channel)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Whether a channel (or an episode's show) sits in a locked category.
pub fn is_locked(db: &Db, channel_id: i64) -> Result<bool> {
    Ok(db
        .read()
        .query_row(
            "SELECT 1 FROM channels c JOIN group_prefs gp ON gp.source_id = c.source_id AND gp.kind = c.kind
               AND gp.name = COALESCE(NULLIF(c.group_name, ''), 'Uncategorized')
             WHERE c.id = COALESCE((SELECT parent_id FROM channels WHERE id = ?1), ?1) AND gp.locked = 1",
            [channel_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

// ---------- favorites ----------

pub fn list_favorites(db: &Db, unlocked: bool) -> Result<Vec<Channel>> {
    let conn = db.read();
    let filter = visibility_clause(false, unlocked).map(|c| format!("WHERE {c}")).unwrap_or_default();
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHANNEL_COLS}
           FROM favorites f JOIN channels c ON c.id = f.channel_id
           {filter}
           ORDER BY f.position, f.added_at DESC"
    ))?;
    let rows = stmt
        .query_map([], row_to_channel)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn toggle_favorite(db: &Db, channel_id: i64) -> Result<bool> {
    let conn = db.write();
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
        // New favorites go to the end of the viewer's order.
        conn.execute(
            "INSERT INTO favorites(channel_id, added_at, position)
             VALUES (?1, strftime('%s','now'), (SELECT COALESCE(MAX(position), -1) + 1 FROM favorites))",
            [channel_id],
        )?;
        Ok(true)
    }
}

/// Put favorites in this order (ids not listed keep their place after).
pub fn reorder_favorites(db: &Db, ids: &[i64]) -> Result<()> {
    let mut conn = db.write();
    let tx = conn.transaction()?;
    tx.execute("UPDATE favorites SET position = position + ?1", [ids.len() as i64])?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute("UPDATE favorites SET position = ?2 WHERE channel_id = ?1", params![id, i as i64])?;
    }
    tx.commit()?;
    Ok(())
}

// ---------- hidden channels ----------

pub fn set_channel_hidden(db: &Db, channel_id: i64, hidden: bool) -> Result<()> {
    let conn = db.write();
    if hidden {
        conn.execute("INSERT OR IGNORE INTO hidden_channels (channel_id) VALUES (?1)", [channel_id])?;
    } else {
        conn.execute("DELETE FROM hidden_channels WHERE channel_id = ?1", [channel_id])?;
    }
    Ok(())
}

pub fn list_hidden_channels(db: &Db) -> Result<Vec<Channel>> {
    let conn = db.read();
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHANNEL_COLS} FROM hidden_channels h JOIN channels c ON c.id = h.channel_id ORDER BY c.kind, c.name"
    ))?;
    let rows = stmt.query_map([], row_to_channel)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
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
    let conn = db.write();
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

pub fn list_watch_history(db: &Db, unlocked: bool) -> Result<Vec<HistoryEntry>> {
    let conn = db.read();
    let filter = visibility_clause(false, unlocked).map(|c| format!("WHERE {c}")).unwrap_or_default();
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHANNEL_COLS}, h.time_pos, h.duration, h.watched_at, h.finished
           FROM watch_history h JOIN channels c ON c.id = h.channel_id
           {filter}
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
    let conn = db.read();
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
    let conn = db.read();
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
    let conn = db.write();
    conn.execute("DELETE FROM watch_history WHERE channel_id = ?1", [channel_id])?;
    Ok(())
}

pub fn clear_watch_history(db: &Db) -> Result<()> {
    let conn = db.write();
    conn.execute("DELETE FROM watch_history", [])?;
    Ok(())
}

// ---------- reminders ----------

pub fn add_reminder(db: &Db, channel_id: i64, start: i64, stop: i64, title: &str) -> Result<()> {
    let conn = db.write();
    conn.execute(
        "INSERT INTO reminders(channel_id, start, stop, title) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(channel_id, start) DO UPDATE SET stop = excluded.stop, title = excluded.title",
        params![channel_id, start, stop, title],
    )?;
    Ok(())
}

pub fn remove_reminder(db: &Db, channel_id: i64, start: i64) -> Result<()> {
    let conn = db.write();
    conn.execute("DELETE FROM reminders WHERE channel_id = ?1 AND start = ?2", params![channel_id, start])?;
    Ok(())
}

/// Reminders for programmes that haven't ended, soonest first. Ended ones
/// are pruned on the way.
pub fn list_reminders(db: &Db) -> Result<Vec<Reminder>> {
    db.write()
        .execute("DELETE FROM reminders WHERE stop < strftime('%s','now')", [])?;
    let conn = db.read();
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHANNEL_COLS}, r.start AS r_start, r.stop AS r_stop, r.title AS r_title
           FROM reminders r JOIN channels c ON c.id = r.channel_id
          ORDER BY r.start"
    ))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Reminder {
                channel: row_to_channel(r)?,
                start: r.get("r_start")?,
                stop: r.get("r_stop")?,
                title: r.get("r_title")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Item counts per kind for one source — the "you're all set" summary.
pub fn source_stats(db: &Db, source_id: i64) -> Result<SourceStats> {
    let conn = db.read();
    let mut stats = SourceStats::default();
    let mut stmt = conn.prepare(
        "SELECT kind, COUNT(*) FROM channels WHERE source_id = ?1 AND parent_id IS NULL GROUP BY kind",
    )?;
    let rows = stmt.query_map([source_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (kind, n) = row?;
        match kind.as_str() {
            "live" => stats.live = n,
            "movie" => stats.movies = n,
            "series" => stats.series = n,
            _ => {}
        }
    }
    Ok(stats)
}

// ---------- app meta ----------

/// When Tenvy was first started on this PC (epoch seconds). Recorded on
/// the first call, so for installs older than this feature it's the
/// first launch after updating.
pub fn installed_at(db: &Db) -> Result<i64> {
    let conn = db.write();
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('installed_at', CAST(unixepoch() AS TEXT))",
        [],
    )?;
    let v: String = conn.query_row("SELECT value FROM meta WHERE key = 'installed_at'", [], |r| r.get(0))?;
    Ok(v.parse().unwrap_or(0))
}

pub fn get_meta(db: &Db, key: &str) -> Result<Option<String>> {
    Ok(db
        .read()
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set_meta(db: &Db, key: &str, value: &str) -> Result<()> {
    db.write().execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ---------- programmes ----------

/// Store a parsed guide: its programmes, and its channel display names for
/// name-based matching.
pub fn upsert_guide(db: &Db, guide: &crate::sources::xmltv::Guide) -> Result<usize> {
    let mut conn = db.write();
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
        for p in &guide.programmes {
            stmt.execute(params![p.channel_tvg_id, p.start, p.stop, p.title, p.description])?;
        }
        let mut names = tx.prepare("INSERT OR IGNORE INTO epg_channels(name_key, id) VALUES (?1, ?2)")?;
        for (id, display_name) in &guide.channel_names {
            let key = crate::sources::xmltv::channel_name_key(display_name);
            if !key.is_empty() {
                names.execute(params![key, id])?;
            }
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
    Ok(guide.programmes.len())
}

fn row_to_programme(r: &rusqlite::Row) -> rusqlite::Result<Programme> {
    Ok(Programme {
        channel_tvg_id: r.get("channel_tvg_id")?,
        start: r.get("start")?,
        stop: r.get("stop")?,
        title: r.get("title")?,
        description: r.get("description")?,
    })
}

/// Programmes overlapping `[from, to)` for the given guide ids.
pub fn programmes_for_channels(
    db: &Db,
    tvg_ids: &[String],
    from: i64,
    to: i64,
) -> Result<Vec<Programme>> {
    if tvg_ids.is_empty() {
        return Ok(vec![]);
    }
    let conn = db.read();
    let placeholders = vec!["?"; tvg_ids.len()].join(",");
    let sql = format!(
        "SELECT channel_tvg_id, start, stop, title, description
           FROM programmes
          WHERE channel_tvg_id IN ({placeholders}) AND stop > ? AND start < ?
          ORDER BY channel_tvg_id, start"
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = tvg_ids
        .iter()
        .map(|s| Box::new(s.to_lowercase()) as Box<dyn rusqlite::ToSql>)
        .collect();
    args.push(Box::new(from));
    args.push(Box::new(to));
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(refs.as_slice(), row_to_programme)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// What's on right now for each of the given guide ids (at most one
/// programme per id). One query for a whole screen of channel rows.
pub fn now_playing(db: &Db, tvg_ids: &[String]) -> Result<Vec<Programme>> {
    let now = chrono::Utc::now().timestamp();
    let mut rows = programmes_for_channels(db, tvg_ids, now, now + 1)?;
    rows.dedup_by(|a, b| a.channel_tvg_id == b.channel_tvg_id);
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        migrate(&conn).unwrap();
        // Separate in-memory connections would be separate databases, so
        // tests route reads and writes through the same one.
        let conn = Arc::new(Mutex::new(conn));
        Db { write: conn.clone(), read: conn }
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
        replace_channels(&db, sid, ALL_KINDS, &[show]).unwrap();
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
        assert_eq!(list_channels(&db, Some(sid), None, None, true).unwrap().len(), 1);
        let show_again = ChannelInsert { kind: "series".into(), container: true, ..ch("Show", "http://h/series/u/p/9") };
        replace_channels(&db, sid, ALL_KINDS, &[show_again]).unwrap();
        assert_eq!(list_episodes(&db, show_id).unwrap().len(), 2);
        assert!(get_watch_entry(&db, eps[0].id).unwrap().is_some());

        // The show disappearing takes its episodes with it.
        replace_channels(&db, sid, ALL_KINDS, &[]).unwrap();
        assert!(list_episodes(&db, show_id).unwrap().is_empty());
    }

    #[test]
    fn reminders_round_trip_and_prune() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        replace_channels(&db, sid, ALL_KINDS, &[ch("A", "http://h/a")]).unwrap();
        let a = id_of(&db, "A");
        let now = chrono::Utc::now().timestamp();
        add_reminder(&db, a, now + 600, now + 3600, "Match").unwrap();
        add_reminder(&db, a, now - 7200, now - 3600, "Old").unwrap();
        let list = list_reminders(&db).unwrap();
        assert_eq!(list.len(), 1, "ended reminders are pruned");
        assert_eq!(list[0].title, "Match");
        remove_reminder(&db, a, now + 600).unwrap();
        assert!(list_reminders(&db).unwrap().is_empty());
        assert_eq!(source_stats(&db, sid).unwrap().live, 1);
    }

    #[test]
    fn channels_without_tvg_id_match_guide_by_name() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        let with_id = ChannelInsert { tvg_id: Some("Kanal5.SE".into()), ..ch("Kanal 5", "http://h/k5") };
        replace_channels(&db, sid, ALL_KINDS, &[ch("SE: SVT1 HD", "http://h/1"), with_id, ch("Unknown", "http://h/u")]).unwrap();
        let guide = crate::sources::xmltv::Guide {
            programmes: vec![Programme {
                channel_tvg_id: "svt1.se".into(),
                start: 0,
                stop: i64::MAX / 2,
                title: "Rapport".into(),
                description: None,
            }],
            channel_names: vec![("svt1.se".into(), "SVT1".into())],
        };
        upsert_guide(&db, &guide).unwrap();

        let rows = list_channels(&db, Some(sid), None, None, true).unwrap();
        let ids: Vec<Option<&str>> = rows.iter().map(|c| c.tvg_id.as_deref()).collect();
        assert_eq!(ids, vec![Some("svt1.se"), Some("kanal5.se"), None]);
        let now = now_playing(&db, &["SVT1.se".into()]).unwrap();
        assert_eq!(now[0].title, "Rapport");
    }

    fn many(prefix: &str, n: usize, kind: &str) -> Vec<ChannelInsert> {
        (0..n)
            .map(|i| ChannelInsert { kind: kind.into(), ..ch(&format!("{prefix}{i}"), &format!("http://h/{prefix}/{i}")) })
            .collect()
    }

    #[test]
    fn refuses_to_wipe_most_of_a_large_list() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        replace_channels(&db, sid, ALL_KINDS, &many("c", 300, "live")).unwrap();
        // A truncated response: only 10 of 300 survive.
        assert!(replace_channels(&db, sid, ALL_KINDS, &many("c", 10, "live")).is_err());
        assert_eq!(list_channels(&db, Some(sid), None, None, true).unwrap().len(), 300);
        // A modest change still goes through.
        replace_channels(&db, sid, ALL_KINDS, &many("c", 250, "live")).unwrap();
        assert_eq!(list_channels(&db, Some(sid), None, None, true).unwrap().len(), 250);
    }

    #[test]
    fn kinds_outside_the_scope_are_kept() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::Xtream, "s", "http://x", None, None).unwrap();
        let mut all = many("l", 5, "live");
        all.extend(many("m", 5, "movie"));
        replace_channels(&db, sid, ALL_KINDS, &all).unwrap();
        // The movie list failed to download this time: only live is synced.
        replace_channels(&db, sid, &["live"], &many("l", 5, "live")).unwrap();
        assert_eq!(list_channels(&db, Some(sid), None, Some("movie"), true).unwrap().len(), 5);
    }

    #[test]
    fn plain_m3u_urls_never_share_an_xtream_identity() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        let list = [ch("A", "http://a.tv/hls/ch/5.m3u8"), ch("B", "http://b.tv/x/y/5.ts")];
        replace_channels(&db, sid, ALL_KINDS, &list).unwrap();
        let (a, b) = (id_of(&db, "A"), id_of(&db, "B"));
        replace_channels(&db, sid, ALL_KINDS, &[list[1].clone(), list[0].clone()]).unwrap();
        assert_eq!((id_of(&db, "A"), id_of(&db, "B")), (a, b));
    }

    fn id_of(db: &Db, name: &str) -> i64 {
        db.read()
            .query_row("SELECT id FROM channels WHERE name = ?1", [name], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn refresh_keeps_favorites_and_history() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        replace_channels(&db, sid, ALL_KINDS, &[ch("A", "http://h/a"), ch("B", "http://h/b")]).unwrap();
        let a = id_of(&db, "A");
        toggle_favorite(&db, a).unwrap();
        upsert_watch_progress(&db, a, 100.0, 1000.0, false).unwrap();

        // Refresh: A renamed and moved, B dropped, C added.
        replace_channels(&db, sid, ALL_KINDS, &[ch("C", "http://h/c"), ch("A2", "http://h/a")]).unwrap();

        assert_eq!(id_of(&db, "A2"), a, "existing channel keeps its id");
        assert_eq!(list_favorites(&db, true).unwrap().len(), 1);
        assert!(get_watch_entry(&db, a).unwrap().is_some());
        let names: Vec<String> = list_channels(&db, Some(sid), None, None, true)
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["C", "A2"]);
    }

    #[test]
    fn xtream_identity_survives_credential_change() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::Xtream, "s", "http://x", None, None).unwrap();
        replace_channels(&db, sid, ALL_KINDS, &[ch("M", "http://old.host/movie/u/oldpw/42.mkv")]).unwrap();
        let m = id_of(&db, "M");
        toggle_favorite(&db, m).unwrap();

        replace_channels(&db, sid, ALL_KINDS, &[ch("M", "http://new.host:8080/movie/u/newpw/42.mkv")]).unwrap();

        assert_eq!(id_of(&db, "M"), m);
        assert_eq!(list_favorites(&db, true).unwrap()[0].stream_url, "http://new.host:8080/movie/u/newpw/42.mkv");
    }

    #[test]
    fn duplicate_urls_are_kept_as_separate_rows() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        let list = [ch("A", "http://h/a"), ch("A again", "http://h/a")];
        replace_channels(&db, sid, ALL_KINDS, &list).unwrap();
        replace_channels(&db, sid, ALL_KINDS, &list).unwrap();
        assert_eq!(list_channels(&db, Some(sid), None, None, true).unwrap().len(), 2);
    }

    #[test]
    fn installed_at_is_recorded_once() {
        let db = test_db();
        let first = installed_at(&db).unwrap();
        assert!(first > 1_700_000_000);
        set_meta(&db, "installed_at", "123").unwrap();
        assert_eq!(installed_at(&db).unwrap(), 123);
        assert_eq!(get_meta(&db, "missing").unwrap(), None);
    }

    #[test]
    fn hidden_and_locked_categories() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        let mk = |name: &str, group: &str| ChannelInsert { group: Some(group.into()), ..ch(name, &format!("http://h/{name}.ts")) };
        replace_channels(&db, sid, ALL_KINDS, &[mk("A", "News"), mk("B", "Adult"), mk("C", "Japan")]).unwrap();
        set_group_prefs(&db, sid, "live", &["Japan".into()], Some(true), None).unwrap();
        set_group_prefs(&db, sid, "live", &["Adult".into()], None, Some(true)).unwrap();

        let names = |v: Vec<Channel>| v.into_iter().map(|c| c.name).collect::<Vec<_>>();
        assert_eq!(names(list_channels(&db, Some(sid), None, None, false).unwrap()), ["A"]);
        assert_eq!(names(list_channels(&db, Some(sid), None, None, true).unwrap()), ["A", "B"]);
        // A hidden category still opens by name; a locked one needs the PIN.
        assert_eq!(names(list_channels(&db, Some(sid), Some("Japan"), None, false).unwrap()), ["C"]);
        assert!(list_channels(&db, Some(sid), Some("Adult"), None, false).unwrap().is_empty());
        assert!(search_channels(&db, "b", Some(sid), None, false).unwrap().is_empty());
        let b = list_channels(&db, Some(sid), Some("Adult"), None, true).unwrap()[0].id;
        assert!(is_locked(&db, b).unwrap());

        let groups = list_groups(&db, Some(sid), Some("live")).unwrap();
        let japan = groups.iter().find(|g| g.name == "Japan").unwrap();
        assert!(japan.hidden && !japan.locked);
        set_group_prefs(&db, sid, "live", &["Japan".into()], Some(false), None).unwrap();
        assert_eq!(list_channels(&db, Some(sid), None, None, false).unwrap().len(), 2);
    }

    #[test]
    fn sources_can_be_renamed() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "test", "http://x", None, None).unwrap();
        rename_source(&db, sid, "Living room").unwrap();
        assert_eq!(get_source(&db, sid).unwrap().unwrap().name, "Living room");
    }

    #[test]
    fn hidden_channels_and_favorite_order() {
        let db = test_db();
        let sid = insert_source(&db, &SourceKind::M3u, "s", "http://x", None, None).unwrap();
        replace_channels(&db, sid, ALL_KINDS, &[ch("A", "http://h/a.ts"), ch("B", "http://h/b.ts"), ch("C", "http://h/c.ts")]).unwrap();
        let all = list_channels(&db, Some(sid), None, None, true).unwrap();
        let (a, b, c) = (all[0].id, all[1].id, all[2].id);

        set_channel_hidden(&db, b, true).unwrap();
        let names = |v: Vec<Channel>| v.into_iter().map(|c| c.name).collect::<Vec<_>>();
        assert_eq!(names(list_channels(&db, Some(sid), None, None, true).unwrap()), ["A", "C"]);
        assert_eq!(names(list_channels(&db, Some(sid), Some("G"), None, true).unwrap()), ["A", "C"]);
        assert!(search_channels(&db, "b", Some(sid), None, true).unwrap().is_empty());
        assert_eq!(names(list_hidden_channels(&db).unwrap()), ["B"]);
        set_channel_hidden(&db, b, false).unwrap();
        assert_eq!(list_channels(&db, Some(sid), None, None, true).unwrap().len(), 3);

        for id in [a, b, c] {
            toggle_favorite(&db, id).unwrap();
        }
        assert_eq!(names(list_favorites(&db, true).unwrap()), ["A", "B", "C"]);
        reorder_favorites(&db, &[c, a]).unwrap();
        assert_eq!(names(list_favorites(&db, true).unwrap()), ["C", "A", "B"]);
    }
}
