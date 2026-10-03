import { create } from 'zustand'
import type { Channel, MpvState, MpvTrack, Programme } from '../types'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ipc } from '../lib/ipc'
import { enterMiniWindow, exitMiniWindow } from '../lib/miniWindow'
import { isResumable, useHistory } from './history'
import { usePlaylist } from './playlist'
import { useUI } from './ui'

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
  /** The live channel watched before this one (Backspace goes back). */
  previous: Channel | null
  /** 0..1 in UI units; mpv's 0..100 conversion happens in `ipc.ts`. */
  volume: number
  muted: boolean
  fullscreen: boolean
  /** Mini player: small always-on-top window showing only the video. */
  mini: boolean
  /** User's play/pause intent. Mirrored to mpv immediately. */
  playing: boolean

  // ---- mpv mirror ----
  timePos: number | null
  duration: number | null
  audioTracks: MpvTrack[]
  subtitleTracks: MpvTrack[]
  currentAudio: number | null
  currentSubtitle: number | null
  /** Mirrors mpv: bumps on every failed open; see MpvState.errorSeq. */
  errorSeq: number
  lastError: string | null

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
  /** Bumped on every `play`, so re-picking the channel that is already
   *  playing (e.g. "Start from beginning") still reloads it. */
  playNonce: number
  /** The playNonce the Player last opened — survives Player remounts so
   *  the same pick is never opened (connected) twice. */
  loadedNonce: number
  /** Set while playing a programme from the provider's archive instead
   *  of the live stream; `channel` is still the live channel. */
  catchup: Programme | null

  // ---- actions ----
  /** Low-level: play this channel, optionally seeking to `startSeconds`
   *  before showing the first frame. */
  play(ch: Channel, startSeconds?: number | null): void
  /** Watch a past (or ongoing, from its start) programme via catch-up. */
  playCatchup(ch: Channel, programme: Programme): void
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
  markLoaded(nonce: number): void

  stop(): void
  setVolume(v: number): void
  toggleMute(): void
  setFullscreen(on: boolean): void
  setMini(on: boolean): void
  setPlaying(on: boolean): void
  setPreferredAudioTrack(idx: number | null): void
  setPreferredSubtitleTrack(idx: number | null): void
  /** Replace the mpv-mirrored slice from an incoming state event. */
  applyMpvState(s: MpvState): void
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  channel: null,
  previous: null,
  volume: 0.8,
  muted: false,
  fullscreen: false,
  mini: false,
  playing: false,

  timePos: null,
  duration: null,
  audioTracks: [],
  subtitleTracks: [],
  currentAudio: null,
  currentSubtitle: null,
  errorSeq: 0,
  lastError: null,

  preferredAudioTrack: null,
  preferredSubtitleTrack: null,

  pendingStart: null,
  pendingResume: null,
  playNonce: 0,
  loadedNonce: -1,
  catchup: null,

  // Reset probed track prefs on channel change — they're per-file. We also
  // clear the mpv mirror so the UI doesn't flash the outgoing file's
  // duration/position while the new load happens.
  play: (ch, startSeconds = null) => {
    // Show the player for it: leave Home, and switch to the matching tab
    // (a live channel picked from search while in Movies, say).
    const ui = useUI.getState()
    if (ui.view === 'home') ui.setView('player')
    const pl = usePlaylist.getState()
    if (pl.activeKind !== ch.kind) pl.setActiveKind(ch.kind).catch(() => {})
    set((s) => ({
      playNonce: s.playNonce + 1,
      catchup: null,
      channel: ch,
      previous: s.channel?.kind === 'live' && s.channel.id !== ch.id ? s.channel : s.previous,
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
    }))
  },

  playCatchup: (ch, programme) => {
    get().play(ch, null)
    set({ catchup: programme })
  },

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
  markLoaded: (nonce) => set({ loadedNonce: nonce }),

  stop: () =>
    set({
      catchup: null,
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
  setFullscreen: (on) => {
    if (get().fullscreen === on) return
    if (on && get().mini) get().setMini(false)
    set({ fullscreen: on })
    // HTML requestFullscreen() needs a user gesture on the JS stack, which
    // double-clicks relayed from the native mpv HWND don't have. The Tauri
    // window API works at the HWND level with no gesture required; the
    // store flag hides the HTML chrome so only the video rect remains.
    getCurrentWindow()
      .setFullscreen(on)
      .catch(() => {
        /* non-fatal — the store flag alone still produces cinema mode */
      })
  },
  setMini: (on) => {
    if (get().mini === on) return
    if (on && get().fullscreen) get().setFullscreen(false)
    set({ mini: on })
    ;(on ? enterMiniWindow() : exitMiniWindow()).catch(() => {
      /* non-fatal — the store flag alone still hides the chrome */
    })
  },
  setPlaying: (on) => {
    set({ playing: on })
    ipc.mpvSetPause(!on).catch(() => {})
  },
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
      errorSeq: s.errorSeq,
      lastError: s.lastError,
      // Reflect mpv's real pause flag so the button stays honest. Only the
      // flag — mpv is briefly `idle` while a new file loads, and treating
      // that as "not playing" used to flip the UI (and mpv) to paused. We
      // do *not* mirror volume or muted — those are pure UI intent.
      playing: !s.paused,
    }),
}))
