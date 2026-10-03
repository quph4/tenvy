-- Schema v1. Run unconditionally; each statement is idempotent.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS sources (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,                    -- m3u | xtream | xmltv
    name       TEXT    NOT NULL,
    url        TEXT    NOT NULL,
    username   TEXT,
    password   TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    tvg_id     TEXT,
    name       TEXT    NOT NULL,
    logo       TEXT,
    group_name TEXT,
    stream_url TEXT    NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    kind       TEXT    NOT NULL DEFAULT 'live'   -- live | movie | series
);

CREATE INDEX IF NOT EXISTS idx_channels_source      ON channels(source_id);
CREATE INDEX IF NOT EXISTS idx_channels_source_grp  ON channels(source_id, group_name);
CREATE INDEX IF NOT EXISTS idx_channels_tvgid       ON channels(tvg_id);
CREATE INDEX IF NOT EXISTS idx_channels_name        ON channels(name);
-- The `kind` column and its index are created in migrate() so that legacy
-- DBs don't blow up on CREATE INDEX before the column has been added.

CREATE TABLE IF NOT EXISTS programmes (
    channel_tvg_id TEXT    NOT NULL,
    start          INTEGER NOT NULL,
    stop           INTEGER NOT NULL,
    title          TEXT    NOT NULL,
    description    TEXT,
    PRIMARY KEY (channel_tvg_id, start)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_programmes_window ON programmes(channel_tvg_id, stop);

CREATE TABLE IF NOT EXISTS favorites (
    channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    added_at   INTEGER NOT NULL
);

-- One row per channel the user has actually watched. Upserted by the
-- player's progress ticker; rows are keyed on channel_id so a second
-- watch overwrites the previous position rather than piling up.
CREATE TABLE IF NOT EXISTS watch_history (
    channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    time_pos    REAL    NOT NULL,
    duration    REAL    NOT NULL,
    watched_at  INTEGER NOT NULL,
    finished    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_history_watched ON watch_history(watched_at DESC);
