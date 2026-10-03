import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Tv2 } from 'lucide-react'
import { usePlayback } from '../../stores/playback'
import { Controls, type PickerKind } from './Controls'
import { TrackPanel, formatTrack, type TrackOption } from './TrackPanel'
import type { Programme } from '../../types'
import { ipc, onMpvEvent, onMpvState } from '../../lib/ipc'
import { useToast } from '../../stores/toast'
import { hhmm } from '../../lib/time'
import { END_GUARD, useHistory } from '../../stores/history'
import { useShallow } from 'zustand/react/shallow'
import { useVideoObscured } from '../../hooks/useVideoObscured'

const DRAWER_WIDTH = 288 // px — tailwind w-72

/**
 * Host for the embedded mpv renderer.
 *
 * mpv is a native child HWND parented under the Tauri window — on Windows,
 * native children draw *above* the WebView2 composition in their own rect.
 * We don't render any pixels ourselves; we render an empty div with the
 * video's position, measure its viewport coordinates, and send those to
 * Rust. Rust calls SetWindowPos to move the child HWND into that rect.
 *
 * Airspace constraint: nothing inside the div can be visible — it's pure
 * real-estate. Any overlay UI (hover scrim, controls) has to live in a
 * sibling positioned *around* the video rect, otherwise WebView2 will
 * draw it behind the HWND and the user won't see it. That's why Controls
 * is a docked strip below the video rather than an overlay on top of it.
 */
export function Player() {
  // Explicit selection (not the whole store) so timePos ticks don't
  // re-render the shell — only Controls needs those.
  const {
    channel,
    volume,
    muted,
    fullscreen,
    setFullscreen,
    audioTracks,
    subtitleTracks,
    currentAudio,
    currentSubtitle,
  } = usePlayback(
    useShallow((s) => ({
      channel: s.channel,
      volume: s.volume,
      muted: s.muted,
      fullscreen: s.fullscreen,
      setFullscreen: s.setFullscreen,
      audioTracks: s.audioTracks,
      subtitleTracks: s.subtitleTracks,
      currentAudio: s.currentAudio,
      currentSubtitle: s.currentSubtitle,
    })),
  )
  const push = useToast((s) => s.push)
  const obscured = useVideoObscured()
  const shellRef = useRef<HTMLDivElement>(null)
  const videoBoxRef = useRef<HTMLDivElement>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [activePicker, setActivePicker] = useState<PickerKind>(null)

  // 1) Init mpv once on mount. Idempotent on the Rust side so strict-mode
  //    double-invoke is fine. Subscribe to state events regardless of
  //    success — if Rust rejected init, no events will fire.
  useEffect(() => {
    let unlisten: (() => void) | null = null

    ipc.mpvInit().catch((e) => {
      setInitError(String(e))
      push('error', `mpv init failed: ${e}`)
    })

    onMpvState((s) => {
      usePlayback.getState().applyMpvState(s)
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {
        /* non-fatal — scrub/track data just won't update */
      })

    return () => {
      unlisten?.()
    }
  }, [push])

  // 2) Load / reload when the user picks a channel. For VOD we look up a
  //    saved resume position and pass it through as mpv's start time,
  //    which is a single load atom — no extra seek round-trip.
  const channelId = channel?.id
  const streamUrl = channel?.streamUrl ?? null
  const isVod = channel?.kind === 'movie' || channel?.kind === 'series'
  useEffect(() => {
    if (!streamUrl) {
      ipc.mpvStop().catch(() => {})
      // Also park the native child off-screen. Sending w=0/h=0 makes the
      // Rust side SW_HIDE the HWND so it doesn't linger over UI when the
      // user clears the channel.
      ipc.mpvSetGeometry(0, 0, 0, 0).catch(() => {})
      return
    }
    // `pendingStart` is a one-shot seek offset the store parked for us
    // when the user picked Resume (or Beginning) at the prompt. Consume
    // it after we hand it to mpv so a later channel-independent re-render
    // doesn't double-apply.
    const start = usePlayback.getState().pendingStart
    usePlayback.getState().consumePendingStart()
    ipc
      .mpvLoad(streamUrl, start)
      // mpv's pause flag survives loadfile — a new channel picked while
      // the previous one was paused should still start playing.
      .then(() => ipc.mpvSetPause(false))
      .catch((e) => {
        // Surface the real failure — mpv-not-on-PATH, unreachable URL, auth
        // rejection, codec refusal. Without this toast the user clicks a
        // channel and sees nothing happen, which is the worst kind of bug.
        const msg = String(e).replace(/^Error:\s*/, '')
        push('error', `Playback failed: ${msg}`)
      })
  }, [streamUrl, isVod, channelId, push])

  // 3) Mirror UI intent → mpv for volume/mute. Play/pause is *not* an
  //    effect: the store mirrors mpv's pause flag back into `playing`, and
  //    an effect on it would feed mpv's transient states straight back in
  //    (that loop used to pause streams while they were loading). The
  //    store's setPlaying talks to mpv directly instead.
  useEffect(() => {
    ipc.mpvSetVolume(muted ? 0 : volume).catch(() => {})
  }, [volume, muted])
  useEffect(() => {
    ipc.mpvSetMuted(muted).catch(() => {})
  }, [muted])

  // 4) Geometry: report the video box's client rect to Rust whenever it
  //    changes. `useLayoutEffect` (not `useEffect`) so the geometry push
  //    fires *before* the browser paints — otherwise the mpv HWND lingers
  //    over the old rect for a frame after sidebar/channel-list mounts
  //    and unmounts (fullscreen toggle, group switches that re-sort the
  //    list and shift the splitter, etc), eating clicks meant for the
  //    newly-laid-out UI. ResizeObserver covers ongoing layout shifts;
  //    fullscreen is in the store (not document.fullscreenElement) since
  //    we use the Tauri window API, so depend on it explicitly.
  useLayoutEffect(() => {
    const el = videoBoxRef.current
    if (!el) return
    if (obscured) {
      // An overlay is open — park the native window so the overlay is
      // actually visible. Zero size makes Rust SW_HIDE the HWND.
      ipc.mpvSetGeometry(0, 0, 0, 0).catch(() => {})
      return
    }

    const push = () => {
      const r = el.getBoundingClientRect()
      // Send raw CSS pixels — Rust's set_geometry scales to physical
      // pixels via GetDpiForWindow, so we don't double-apply DPR here.
      ipc.mpvSetGeometry(r.left, r.top, r.width, r.height).catch(() => {})
    }

    push()
    // RAF-delayed second push picks up any layout shift that happens in
    // the same frame (a sibling pane mounting, a virtualizer settling its
    // first measurement). Without this, fullscreen exit + an immediate
    // group-switch click can land on stale HWND territory.
    const raf = requestAnimationFrame(push)
    const ro = new ResizeObserver(push)
    ro.observe(el)
    window.addEventListener('resize', push)
    window.addEventListener('scroll', push, true)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', push)
      window.removeEventListener('scroll', push, true)
    }
    // Rerun when channel changes (empty state ↔ video box), fullscreen
    // toggles (siblings unmount/remount and the box jumps), or an overlay
    // opens/closes.
  }, [channel?.id, fullscreen, obscured])

  // The Player unmounts when the user switches to the Guide view. Without
  // this the native window would stay parked at its last rect, floating
  // over the guide and swallowing its clicks.
  useEffect(() => {
    return () => {
      ipc.mpvSetGeometry(0, 0, 0, 0).catch(() => {})
    }
  }, [])

  // 5) VOD resume: save the last known position periodically + on channel
  //    switch. We track the last non-null position ourselves because by the
  //    time the cleanup runs, `play()` has already reset the store's
  //    timePos/duration for the next channel.
  useEffect(() => {
    if (!isVod || channelId === undefined) return
    const last = { timePos: null as number | null, duration: null as number | null }
    const unsubscribe = usePlayback.subscribe((s) => {
      if (s.channel?.id !== channelId) return
      if (s.timePos != null) last.timePos = s.timePos
      if (s.duration != null && s.duration > 0) last.duration = s.duration
    })
    const save = () => {
      const { timePos, duration } = last
      if (timePos == null || duration == null || duration <= 0) return
      // Near the end? Flag the row as finished but keep the entry so the
      // History view can show "Watched" badges. The sticky `finished` bit
      // in the DB means a re-watch that restarts won't reset this.
      const finished = timePos >= duration - END_GUARD
      // Don't store noise for the first few seconds — a misclick that
      // closes the player shouldn't stamp a fresh row that then outranks
      // the user's actual recent picks in the History list.
      if (!finished && timePos < 3) return
      useHistory
        .getState()
        .record(channelId, timePos, duration, finished)
        .catch(() => {})
    }
    const interval = window.setInterval(save, 5000)
    return () => {
      window.clearInterval(interval)
      unsubscribe()
      save() // final save on channel switch / unmount
    }
  }, [isVod, channelId])

  // The store's setFullscreen drives the Tauri window; ResizeObserver on
  // videoBoxRef then pushes the new geometry so the native child fills it.
  const toggleFullscreen = () => setFullscreen(!usePlayback.getState().fullscreen)

  // Double-click on the video rect routes through the native HWND → Rust →
  // this event. The HWND swallows pointer events before WebView2 can see
  // them, so an HTML `onDoubleClick` on the video div never fires; instead
  // the child window's wnd_proc catches WM_LBUTTONDBLCLK and Rust emits
  // `mpv://event`.
  //
  // `crashed` means the mpv process died. The next IPC call respawns it, so
  // reload the current channel from where it was — but only once per
  // channel per 30s, so a stream that reliably crashes mpv can't loop.
  const lastCrashReload = useRef<{ channelId: number; at: number } | null>(null)
  useEffect(() => {
    let unlisten: (() => void) | null = null
    onMpvEvent((ev) => {
      if (ev.kind === 'double-click') {
        const { fullscreen, setFullscreen } = usePlayback.getState()
        setFullscreen(!fullscreen)
      } else if (ev.kind === 'crashed') {
        const { channel, timePos } = usePlayback.getState()
        const prev = lastCrashReload.current
        if (!channel || (prev?.channelId === channel.id && Date.now() - prev.at < 30_000)) {
          push('error', 'The player stopped unexpectedly.')
          return
        }
        lastCrashReload.current = { channelId: channel.id, at: Date.now() }
        push('info', 'The player stopped unexpectedly — restarting…')
        const isVodNow = channel.kind === 'movie' || channel.kind === 'series'
        ipc
          .mpvLoad(channel.streamUrl, isVodNow ? timePos : null)
          .catch((e) => push('error', `Playback failed: ${String(e).replace(/^Error:\s*/, '')}`))
      }
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      unlisten?.()
    }
  }, [push])

  const audioOptions: TrackOption[] = audioTracks.map((t, i) => ({
    id: String(t.id),
    label: formatTrack(t, i, true),
    active: currentAudio === t.id,
  }))
  const subtitleOptions: TrackOption[] = [
    { id: '__off__', label: 'Off', active: currentSubtitle == null },
    ...subtitleTracks.map((t, i) => ({
      id: String(t.id),
      label: formatTrack(t, i, false),
      active: currentSubtitle === t.id,
    })),
  ]

  const onSelectAudio = (id: string) => {
    const n = Number(id)
    if (Number.isFinite(n)) {
      usePlayback.getState().setPreferredAudioTrack(n)
      ipc.mpvSetAudioTrack(n).catch(() => {})
    }
    setActivePicker(null)
  }
  const onSelectSubtitle = (id: string) => {
    if (id === '__off__') {
      usePlayback.getState().setPreferredSubtitleTrack(null)
      ipc.mpvSetSubtitleTrack(null).catch(() => {})
    } else {
      const n = Number(id)
      if (Number.isFinite(n)) {
        usePlayback.getState().setPreferredSubtitleTrack(n)
        ipc.mpvSetSubtitleTrack(n).catch(() => {})
      }
    }
    setActivePicker(null)
  }

  return (
    <section ref={shellRef} className="group flex flex-1 flex-col bg-black">
      {channel ? (
        <>
          {/* Horizontal split: video+controls column on the left, track
              drawer on the right. The drawer animates its width; the video
              column (flex-1) narrows fluidly, ResizeObserver fires per
              frame and the mpv HWND tracks the new rect — no jerk. mpv's
              keepaspect means the actual image barely changes; the
              difference shows up as slight pillarbox instead of a resize. */}
          <div className="relative flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <div
                ref={videoBoxRef}
                className="relative flex-1 bg-black"
                aria-label="Video"
              />
              {!fullscreen && (
                <Controls
                  onToggleFullscreen={toggleFullscreen}
                  activePicker={activePicker}
                  onTogglePicker={setActivePicker}
                />
              )}
            </div>
            <div
              aria-hidden={activePicker === null}
              style={{ width: activePicker ? DRAWER_WIDTH : 0 }}
              className="shrink-0 overflow-hidden border-l border-zinc-800/70 bg-zinc-950/95 transition-[width] duration-200 ease-out"
            >
              <div style={{ width: DRAWER_WIDTH }} className="h-full">
                {activePicker === 'audio' && (
                  <TrackPanel
                    label="Audio track"
                    options={audioOptions}
                    emptyHint="No audio tracks detected yet."
                    onSelect={onSelectAudio}
                    onClose={() => setActivePicker(null)}
                  />
                )}
                {activePicker === 'subtitle' && (
                  <TrackPanel
                    label="Subtitles"
                    options={subtitleOptions}
                    onSelect={onSelectSubtitle}
                    onClose={() => setActivePicker(null)}
                  />
                )}
              </div>
            </div>
          </div>
          {!isVod && !fullscreen && <NowNext />}
        </>
      ) : (
        <PlayerEmpty error={initError} />
      )}
    </section>
  )
}

function PlayerEmpty({ error }: { error: string | null }) {
  return (
    <div className="grid h-full place-items-center text-center">
      <div className="max-w-sm space-y-3 animate-fade-in">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-zinc-900 text-zinc-500">
          <Tv2 className="h-6 w-6" />
        </div>
        <div className="text-sm font-medium text-zinc-300">Pick a channel</div>
        <div className="text-xs text-zinc-500">
          Select something from the list on the left, or press{' '}
          <span className="kbd">Ctrl K</span> to search.
        </div>
        {error && (
          <div className="mt-4 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-left text-[11px] text-red-300">
            <div className="font-semibold">mpv unavailable</div>
            <div className="mt-1 break-words opacity-80">{error}</div>
            <div className="mt-2 text-red-400/80">
              Install mpv (add `mpv.exe` to PATH or C:\Program Files\mpv\) and
              restart Lumen.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function NowNext() {
  const channel = usePlayback((s) => s.channel)
  const [now, setNow] = useState<Programme | null>(null)
  const [next, setNext] = useState<Programme | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!channel?.tvgId) {
      setNow(null)
      setNext(null)
      return
    }
    const load = async () => {
      const t = Math.floor(Date.now() / 1000)
      const progs = await ipc.programmesForChannels({
        tvgIds: [channel.tvgId!],
        from: t,
        to: t + 6 * 3600,
      })
      if (cancelled) return
      setNow(progs[0] ?? null)
      setNext(progs[1] ?? null)
    }
    load().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [channel?.id, channel?.tvgId])

  if (!now && !next) return null

  return (
    <div className="border-t border-zinc-800/70 bg-zinc-950/80 px-5 py-3 backdrop-blur">
      <div className="flex items-baseline gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400">Now</span>
        {now ? (
          <>
            <span className="truncate text-sm font-medium text-zinc-100">{now.title}</span>
            <span className="shrink-0 text-xs tabular-nums text-zinc-500">
              {hhmm(now.start)} – {hhmm(now.stop)}
            </span>
          </>
        ) : (
          <span className="text-xs text-zinc-500">No guide data</span>
        )}
      </div>
      {next && (
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Next</span>
          <span className="truncate text-sm text-zinc-400">{next.title}</span>
          <span className="shrink-0 text-xs tabular-nums text-zinc-600">{hhmm(next.start)}</span>
        </div>
      )}
    </div>
  )
}
