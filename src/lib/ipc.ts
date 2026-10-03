import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AppInfo,
  Channel,
  ChannelKind,
  Group,
  HistoryEntry,
  HistoryProgress,
  MpvState,
  Programme,
  Source,
  Reminder,
  SourceKind,
  SourceStats,
  TrackPrefs,
  VodDetails,
} from '../types'

// Typed wrappers so the rest of the app doesn't know `invoke()` exists.
// If a Rust command is ever renamed, there's exactly one place to update.

export const ipc = {
  async listSources(): Promise<Source[]> {
    return invoke('list_sources')
  },
  async addSource(args: {
    kind: SourceKind
    name: string
    url: string
    username?: string
    password?: string
  }): Promise<Source> {
    return invoke('add_source', { req: args })
  },
  async refreshSource(id: number): Promise<void> {
    return invoke('refresh_source', { id })
  },
  async removeSource(id: number): Promise<void> {
    return invoke('remove_source', { id })
  },

  async listGroups(sourceId: number | null, kind: ChannelKind | null): Promise<Group[]> {
    return invoke('list_groups', { sourceId, kind })
  },
  async listChannels(args: {
    sourceId: number | null
    group: string | null
    kind: ChannelKind | null
  }): Promise<Channel[]> {
    return invoke('list_channels', args)
  },
  /** Substring search across every group (top-level rows only). */
  async searchChannels(
    query: string,
    opts: { sourceId?: number | null; kind?: ChannelKind | null } = {},
  ): Promise<Channel[]> {
    return invoke('search_channels', {
      query,
      sourceId: opts.sourceId ?? null,
      kind: opts.kind ?? null,
    })
  },
  /** Episodes of a series container (`channel.container`), in order.
   *  Fetched from the provider each call, served from cache offline. */
  async listEpisodes(channelId: number): Promise<Channel[]> {
    return invoke('list_episodes', { channelId })
  },
  async addReminder(channelId: number, p: { start: number; stop: number; title: string }): Promise<void> {
    return invoke('add_reminder', { channelId, start: p.start, stop: p.stop, title: p.title })
  },
  async removeReminder(channelId: number, start: number): Promise<void> {
    return invoke('remove_reminder', { channelId, start })
  },
  /** Upcoming and ongoing reminders, soonest first. */
  async listReminders(): Promise<Reminder[]> {
    return invoke('list_reminders')
  },
  async openLicenses(): Promise<void> {
    return invoke('open_licenses')
  },
  async getChannel(id: number): Promise<Channel | null> {
    return invoke('get_channel', { id })
  },
  async sourceStats(id: number): Promise<SourceStats> {
    return invoke('source_stats', { id })
  },
  /** Install date and the remote config (cached copy when offline). */
  async appInfo(): Promise<AppInfo> {
    return invoke('app_info')
  },
  /** Plot, cast, artwork and trailer for a movie or series (cached). */
  async vodDetails(channelId: number): Promise<VodDetails> {
    return invoke('vod_details', { channelId })
  },

  // ---- Watch history ----
  async recordHistory(args: {
    channelId: number
    timePos: number
    duration: number
    finished: boolean
  }): Promise<void> {
    return invoke('record_history', args)
  },
  async listHistory(): Promise<HistoryEntry[]> {
    return invoke('list_history')
  },
  async listHistoryProgress(): Promise<HistoryProgress[]> {
    return invoke('list_history_progress')
  },
  async getHistoryEntry(channelId: number): Promise<HistoryProgress | null> {
    return invoke('get_history_entry', { channelId })
  },
  async removeHistoryEntry(channelId: number): Promise<void> {
    return invoke('remove_history_entry', { channelId })
  },
  async clearHistory(): Promise<void> {
    return invoke('clear_history')
  },

  async listFavorites(): Promise<Channel[]> {
    return invoke('list_favorites')
  },
  async toggleFavorite(channelId: number): Promise<boolean> {
    return invoke('toggle_favorite', { channelId })
  },

  async programmesForChannels(args: {
    tvgIds: string[]
    from: number
    to: number
  }): Promise<Programme[]> {
    return invoke('programmes_for_channels', args)
  },
  /** What's on now for each guide id (at most one programme per id). */
  async nowPlaying(tvgIds: string[]): Promise<Programme[]> {
    return invoke('now_playing', { tvgIds })
  },

  /**
   * Open a channel in mpv/VLC. Optionally pre-select audio/subtitle tracks
   * by mpv track id — the backend turns these into mpv `--aid` / `--sid`
   * flags (or VLC's 0-based `--audio-track` / `--sub-track`). Pass `null`
   * to keep the player's defaults; pass a number to force that track.
   * Returns the path of the external player that was launched.
   */
  async openExternal(
    channelId: number,
    opts?: { audioTrack?: number | null; subtitleTrack?: number | null },
  ): Promise<string> {
    return invoke('open_external', {
      channelId,
      audioTrack: opts?.audioTrack ?? null,
      subtitleTrack: opts?.subtitleTrack ?? null,
    })
  },

  // ---- Embedded mpv surface ----
  // Everything below corresponds 1:1 to a Tauri command in
  // src-tauri/src/commands/mpv_state.rs. On non-Windows they return an
  // error — the UI guards against calling them by gating features on
  // `window.__TAURI_OS__` at a higher level. (v1 is Windows-only anyway.)
  async mpvInit(): Promise<void> {
    return invoke('mpv_init')
  },
  /** Play a channel by id; the backend resolves its URL and headers. */
  async mpvLoad(channelId: number, startSeconds: number | null = null, prefs?: TrackPrefs): Promise<void> {
    return invoke('mpv_load', { channelId, startSeconds, prefs: prefs ?? null })
  },
  /** Play a past or ongoing programme from the provider's archive.
   *  `start`/`stop` are the programme's epoch seconds from the guide. */
  async mpvLoadCatchup(channelId: number, start: number, stop: number, prefs?: TrackPrefs): Promise<void> {
    return invoke('mpv_load_catchup', { channelId, start, stop, prefs: prefs ?? null })
  },
  /** Text drawn over the video by mpv — visible even in fullscreen. */
  async mpvShowText(text: string, durationMs = 4000): Promise<void> {
    return invoke('mpv_show_text', { text, durationMs })
  },
  async mpvSetPause(paused: boolean): Promise<void> {
    return invoke('mpv_set_pause', { paused })
  },
  async mpvSeek(seconds: number): Promise<void> {
    return invoke('mpv_seek', { seconds })
  },
  async mpvSetVolume(volume: number): Promise<void> {
    // mpv's volume property is 0..100, not 0..1.
    return invoke('mpv_set_volume', { volume: Math.round(volume * 100) })
  },
  async mpvSetMuted(muted: boolean): Promise<void> {
    return invoke('mpv_set_muted', { muted })
  },
  async mpvSetAudioTrack(trackId: number | null): Promise<void> {
    return invoke('mpv_set_audio_track', { trackId })
  },
  async mpvSetSubtitleTrack(trackId: number | null): Promise<void> {
    return invoke('mpv_set_subtitle_track', { trackId })
  },
  async mpvSetGeometry(x: number, y: number, w: number, h: number): Promise<void> {
    return invoke('mpv_set_geometry', {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
    })
  },
  async mpvStop(): Promise<void> {
    return invoke('mpv_stop')
  },
  async mpvGetState(): Promise<MpvState> {
    return invoke('mpv_get_state')
  },
}

/**
 * Subscribe to mpv state updates streamed from Rust. Rust emits a full
 * snapshot every time any observed property changes — no patching on the
 * JS side, the handler just replaces local state wholesale.
 */
export async function onMpvState(handler: (s: MpvState) => void): Promise<UnlistenFn> {
  return listen<MpvState>('mpv://state', (e) => handler(e.payload))
}

/**
 * Out-of-band mpv events (double-click caught by the native HWND, etc.).
 * These don't flow through the state snapshot channel because they're
 * one-shot signals — the native mpv HWND captures pointer events before
 * WebView2 sees them, so we get them back through this side channel.
 */
export type MpvEvent = { kind: 'double-click' } | { kind: 'crashed' }
export async function onMpvEvent(handler: (e: MpvEvent) => void): Promise<UnlistenFn> {
  return listen<MpvEvent>('mpv://event', (e) => handler(e.payload))
}

export async function onPlaylistProgress(
  handler: (p: { sourceId: number; stage: string; count: number }) => void,
): Promise<UnlistenFn> {
  return listen<{ sourceId: number; stage: string; count: number }>('playlist-progress', (e) =>
    handler(e.payload),
  )
}

/**
 * Attach a Tauri event listener from a React effect: returns a synchronous
 * cleanup. `listen()` resolves asynchronously, so if the effect is torn
 * down first (StrictMode, fast unmount) the listener is removed as soon as
 * it arrives instead of leaking.
 */
export function subscribe(attach: () => Promise<UnlistenFn>): () => void {
  let disposed = false
  let unlisten: UnlistenFn | null = null
  attach()
    .then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    .catch(() => {
      /* non-fatal — the UI just won't live-update from this event */
    })
  return () => {
    disposed = true
    unlisten?.()
  }
}
