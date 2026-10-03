// Shared domain types mirrored 1:1 with the Rust side in src-tauri/src/models.rs

export type SourceKind = 'm3u' | 'xtream' | 'xmltv'

/** What kind of content a channel row points at. */
export type ChannelKind = 'live' | 'movie' | 'series'

export interface Source {
  id: number
  kind: SourceKind
  name: string
  url: string
  updatedAt: number
}

export interface Channel {
  id: number
  sourceId: number
  tvgId: string | null
  name: string
  logo: string | null
  group: string | null
  streamUrl: string
  sortOrder: number
  kind: ChannelKind
  /** A series show whose episodes load on demand via `ipc.listEpisodes`. */
  container: boolean
  /** Set on episodes: the show (container) they belong to. */
  parentId: number | null
  season: number | null
  episode: number | null
  /** Days of catch-up the provider keeps (live channels), else null. */
  archiveDays: number | null
  /** Movies/series: rating out of 10, release year, provider-added time. */
  rating: number | null
  year: number | null
  added: number | null
}

/** A programme the user asked to be reminded of. */
export interface Reminder {
  channel: Channel
  start: number
  stop: number
  title: string
}

/** Top-level item counts for a source. */
export interface SourceStats {
  live: number
  movies: number
  series: number
}

/** A movie or series details page (see Rust models::VodDetails). */
export interface VodDetails {
  plot: string | null
  genre: string | null
  cast: string | null
  director: string | null
  releaseDate: string | null
  rating: number | null
  duration: string | null
  poster: string | null
  backdrop: string | null
  trailer: string | null
}

export interface Programme {
  channelTvgId: string
  start: number // epoch seconds
  stop: number
  title: string
  description: string | null
}

export interface Group {
  name: string
  count: number
}


/** One live track from mpv's `track-list`. Shape mirrors
 *  src-tauri/src/commands/mpv_state.rs TrackInfoDto (camelCase via serde). */
export interface MpvTrack {
  /** mpv's 1-based ordinal within this stream type — what `--aid` / `--sid` use. */
  id: number
  /** "audio" | "sub" | "video" */
  kind: string
  title: string | null
  lang: string | null
  codec: string | null
  channels: number | null
  default: boolean | null
  selected: boolean | null
}

/** Snapshot emitted by Rust on every observed-property change. */
export interface MpvState {
  playing: boolean
  paused: boolean
  idle: boolean
  /** Current playback position in seconds, null before first frame. */
  timePos: number | null
  duration: number | null
  /** 0..100 in mpv's own units. */
  volume: number | null
  muted: boolean
  audioTracks: MpvTrack[]
  subtitleTracks: MpvTrack[]
  currentAudio: number | null
  currentSubtitle: number | null
  /** Increments every time a stream fails to open. */
  errorSeq: number
  /** mpv's reason for the latest failure, e.g. "loading failed". */
  lastError: string | null
}

/** One row from the watch_history table, joined with its channel. */
export interface HistoryEntry {
  channel: Channel
  timePos: number
  duration: number
  /** epoch seconds */
  watchedAt: number
  finished: boolean
}

/** Lightweight progress row, keyed by channel id — used by the channel list
 *  to decide whether to draw a progress bar or a "watched" badge. */
export interface HistoryProgress {
  channelId: number
  timePos: number
  duration: number
  watchedAt: number
  finished: boolean
}

/** Settings read from the web at startup (see src-tauri/src/remote.rs). */
export interface RemoteConfig {
  model: string
  support: { url: string; label: string | null; message: string | null } | null
  supportPrompt: { afterDays: number; everyDays: number } | null
  announcements: { id: string; text: string; url: string | null }[]
}

export interface AppInfo {
  /** First launch on this PC, epoch seconds. */
  installedAt: number
  config: RemoteConfig
}

/** Remembered language choices, sent with every load (Rust TrackPrefs). */
export interface TrackPrefs {
  audioLang: string | null
  subLang: string | null
  subsOff: boolean
}
