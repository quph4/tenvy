import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  Channel,
  ChannelKind,
  Group,
  HistoryEntry,
  HistoryProgress,
  MpvState,
  ProbedTracks,
  Programme,
  Source,
  SourceKind,
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
  async searchChannels(query: string, kind: ChannelKind | null): Promise<Channel[]> {
    return invoke('search_channels', { query, kind })
  },

  /**
   * Ask the backend what audio/subtitle tracks live inside a VOD's container.
   * For Xtream sources this hits `get_vod_info`; for generic M3U it returns
   * empty. Results are cached server-side for 10 min.
   */
  async probeTracks(channelId: number): Promise<ProbedTracks> {
    return invoke('probe_tracks', { channelId })
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
  async currentProgramme(tvgId: string): Promise<Programme | null> {
    return invoke('current_programme', { tvgId })
  },

  async logError(msg: string): Promise<void> {
    return invoke('log_error', { msg })
  },
  /**
   * Launch the URL in mpv/VLC. Optionally pre-select audio/subtitle tracks
   * by MKV track number — the backend turns these into mpv `--aid` /
   * `--sid` flags (or VLC `--audio-track` / `--sub-track`). Pass `null`
   * to keep the player's defaults; pass a number to force that track.
   * Returns the path of the external player that was launched.
   */
  async openExternal(
    url: string,
    opts?: { audioTrack?: number | null; subtitleTrack?: number | null },
  ): Promise<string> {
    return invoke('open_external', {
      url,
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
  async mpvLoad(url: string, startSeconds: number | null = null): Promise<void> {
    return invoke('mpv_load', { url, startSeconds })
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
export type MpvEvent = { kind: 'double-click' }
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
