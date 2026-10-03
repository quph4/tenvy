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
