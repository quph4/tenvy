import { create } from 'zustand'
import type { Channel, MpvState, MpvTrack } from '../types'
import { isResumable, useHistory } from './history'

/**
 * Playback state for the embedded mpv renderer.
 *
 * We keep three kinds of state here:
 *   - UI intent (channel, volume, muted, fullscreen) — what the user asked
 *     for. Writes from the React tree are sent to mpv via `ipc.mpv*` as
 *     side effects; the store is source-of-truth for the UI.
 *   - mpv mirror (playing, timePos, duration, audioTracks, …) — replaced
 *     wholesale every time a `mpv://state` event fires. The React tree
 *     reads this to render scrub position, track pickers, etc.
 *   - Resume-prompt state (pendingResume, pendingStart). A VOD with a
 *     saved position routes through `requestPlay`, which either opens the
 *     prompt or plays immediately; `pendingStart` is a one-shot offset
 *     the Player reads when it calls `mpvLoad`.
 */
interface PlaybackState {
  // ---- UI intent ----
  channel: Channel | null
  /** 0..1 in UI units; mpv's 0..100 conversion happens in `ipc.ts`. */
  volume: number
  muted: boolean
  fullscreen: boolean
  /** User's play/pause intent. Mirrored to mpv immediately. */
  playing: boolean

  // ---- mpv mirror ----
  timePos: number | null
  duration: number | null
  audioTracks: MpvTrack[]
  subtitleTracks: MpvTrack[]
  currentAudio: number | null
  currentSubtitle: number | null

  // ---- external-launch prefs ----
  preferredAudioTrack: number | null
  preferredSubtitleTrack: number | null

  // ---- resume flow ----
  /** One-shot seek offset the Player effect reads after a `play`. `null`
   *  means "let mpv start from zero" (which is also the right call for
   *  live streams). Cleared by the Player after it consumes the value. */
  pendingStart: number | null
  /** VOD the user clicked on that has a resumable saved position. The
   *  app-level modal watches this and asks Resume vs. Beginning. */
  pendingResume: { channel: Channel; savedSeconds: number } | null

  // ---- actions ----
  /** Low-level: play this channel, optionally seeking to `startSeconds`
   *  before showing the first frame. */
  play(ch: Channel, startSeconds?: number | null): void
  /** High-level: if the channel has a resumable saved position, open the
   *  resume prompt; otherwise start immediately. Call this from row clicks. */
  requestPlay(ch: Channel): void
  /** Resolve the open resume prompt. `fromBeginning = true` clears the
   *  saved progress row so "Beginning" feels like a fresh start. */
  resolveResume(fromBeginning: boolean): void
  cancelResume(): void
  /** Mark the stash-start offset as consumed. Called by the Player after
   *  it feeds the value into `mpvLoad`. */
  consumePendingStart(): void

  stop(): void
  setVolume(v: number): void
  toggleMute(): void
  setFullscreen(on: boolean): void
  setPlaying(on: boolean): void
  setPreferredAudioTrack(idx: number | null): void
  setPreferredSubtitleTrack(idx: number | null): void
  /** Replace the mpv-mirrored slice from an incoming state event. */
  applyMpvState(s: MpvState): void
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  channel: null,
  volume: 0.8,
  muted: false,
  fullscreen: false,
  playing: false,

  timePos: null,
  duration: null,
  audioTracks: [],
  subtitleTracks: [],
  currentAudio: null,
  currentSubtitle: null,

  preferredAudioTrack: null,
  preferredSubtitleTrack: null,

  pendingStart: null,
  pendingResume: null,

  // Reset probed track prefs on channel change — they're per-file. We also
  // clear the mpv mirror so the UI doesn't flash the outgoing file's
  // duration/position while the new load happens.
  play: (ch, startSeconds = null) =>
    set({
      channel: ch,
      playing: true,
      pendingStart: startSeconds,
      pendingResume: null,
      timePos: null,
      duration: null,
      audioTracks: [],
      subtitleTracks: [],
      currentAudio: null,
      currentSubtitle: null,
      preferredAudioTrack: null,
      preferredSubtitleTrack: null,
    }),

  requestPlay: (ch) => {
    const isVod = ch.kind === 'movie' || ch.kind === 'series'
    if (!isVod) {
      get().play(ch, null)
      return
    }
    const progress = useHistory.getState().progress.get(ch.id)
    if (isResumable(progress)) {
      set({ pendingResume: { channel: ch, savedSeconds: progress.timePos } })
    } else {
      get().play(ch, null)
    }
  },

  resolveResume: (fromBeginning) => {
    const pending = get().pendingResume
    if (!pending) return
    set({ pendingResume: null })
    if (fromBeginning) {
      // Drop the saved row so the progress bar disappears too — "from the
      // beginning" implies a clean slate until the next tick overwrites it.
      useHistory.getState().remove(pending.channel.id).catch(() => {})
      get().play(pending.channel, 0)
    } else {
      get().play(pending.channel, pending.savedSeconds)
    }
  },

  cancelResume: () => set({ pendingResume: null }),

  consumePendingStart: () => set({ pendingStart: null }),

  stop: () =>
    set({
      channel: null,
      playing: false,
      pendingStart: null,
      timePos: null,
      duration: null,
      audioTracks: [],
      subtitleTracks: [],
      currentAudio: null,
      currentSubtitle: null,
    }),
  setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)) }),
  toggleMute: () => set((s) => ({ muted: !s.muted })),
  setFullscreen: (on) => set({ fullscreen: on }),
  setPlaying: (on) => set({ playing: on }),
  setPreferredAudioTrack: (idx) => set({ preferredAudioTrack: idx }),
  setPreferredSubtitleTrack: (idx) => set({ preferredSubtitleTrack: idx }),
  applyMpvState: (s) =>
    set({
      timePos: s.timePos,
      duration: s.duration,
      audioTracks: s.audioTracks,
      subtitleTracks: s.subtitleTracks,
      currentAudio: s.currentAudio,
      currentSubtitle: s.currentSubtitle,
      // Reflect mpv's real play/pause so the button stays honest if the
      // user hit the OSC inside the video pane. We do *not* mirror volume
      // or muted — those are pure UI intent on our side.
      playing: !s.paused && !s.idle,
    }),
}))
