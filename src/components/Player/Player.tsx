import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bell, RotateCcw, Tv2 } from 'lucide-react'
import { useReminders } from '../../stores/reminders'
import type { Channel } from '../../types'
import { usePlayback } from '../../stores/playback'
import { Controls, type PickerKind } from './Controls'
import { TrackPanel, formatTrack, type TrackOption } from './TrackPanel'
import { PicturePanel } from './PicturePanel'
import { UpNext } from './UpNext'
import type { Programme } from '../../types'
import { ipc } from '../../lib/ipc'
import { useToast } from '../../stores/toast'
import { hhmm } from '../../lib/time'
import { useShallow } from 'zustand/react/shallow'
import { useVideoObscured } from '../../hooks/useVideoObscured'
import { useTvPrefs } from '../../stores/tvPrefs'

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
    fullscreen,
    mini,
    setFullscreen,
    audioTracks,
    subtitleTracks,
    currentAudio,
    currentSubtitle,
  } = usePlayback(
    useShallow((s) => ({
      channel: s.channel,
      fullscreen: s.fullscreen,
      mini: s.mini,
      setFullscreen: s.setFullscreen,
      audioTracks: s.audioTracks,
      subtitleTracks: s.subtitleTracks,
      currentAudio: s.currentAudio,
      currentSubtitle: s.currentSubtitle,
    })),
  )
  const obscured = useVideoObscured()
  const shellRef = useRef<HTMLDivElement>(null)
  const videoBoxRef = useRef<HTMLDivElement>(null)
  const initError = usePlayback((s) => s.initError)
  const catchup = usePlayback((s) => s.catchup)
  const isVod = channel?.kind === 'movie' || channel?.kind === 'series'
  const [activePicker, setActivePicker] = useState<PickerKind>(null)





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
  }, [channel?.id, fullscreen, mini, obscured])

  // The Player unmounts when the user switches to the Guide view. Without
  // this the native window would stay parked at its last rect, floating
  // over the guide and swallowing its clicks.
  useEffect(() => {
    return () => {
      ipc.mpvSetGeometry(0, 0, 0, 0).catch(() => {})
    }
  }, [])


  // The store's setFullscreen drives the Tauri window; ResizeObserver on
  // videoBoxRef then pushes the new geometry so the native child fills it.
  const toggleFullscreen = () => setFullscreen(!usePlayback.getState().fullscreen)


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
      useTvPrefs.getState().pickedAudio(audioTracks.find((t) => t.id === n))
      ipc.mpvSetAudioTrack(n).catch(() => {})
    }
    setActivePicker(null)
  }
  const onSelectSubtitle = (id: string) => {
    if (id === '__off__') {
      usePlayback.getState().setPreferredSubtitleTrack(null)
      useTvPrefs.getState().pickedSubtitle(undefined)
      ipc.mpvSetSubtitleTrack(null).catch(() => {})
    } else {
      const n = Number(id)
      if (Number.isFinite(n)) {
        usePlayback.getState().setPreferredSubtitleTrack(n)
        useTvPrefs.getState().pickedSubtitle(subtitleTracks.find((t) => t.id === n))
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
              {!fullscreen && <UpNext />}
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
              className="shrink-0 overflow-hidden border-l border-neutral-800/70 bg-neutral-950/95 transition-[width] duration-200 ease-out"
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
                {activePicker === 'picture' && <PicturePanel onClose={() => setActivePicker(null)} />}
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
          {!isVod && !fullscreen && !mini && !catchup && <NowNext />}
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
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-neutral-900 text-neutral-500">
          <Tv2 className="h-6 w-6" />
        </div>
        <div className="text-sm font-medium text-neutral-300">Pick a channel</div>
        <div className="text-xs text-neutral-500">
          Select something from the list on the left, or press{' '}
          <span className="kbd">Ctrl K</span> to search.
        </div>
        {error && (
          <div className="mt-4 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-left text-[11px] text-red-300">
            <div className="font-semibold">mpv unavailable</div>
            <div className="mt-1 break-words opacity-80">{error}</div>
            <div className="mt-2 text-red-400/80">
              Install mpv (add `mpv.exe` to PATH or C:\Program Files\mpv\) and
              restart Tenvy.
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
    <div className="border-t border-neutral-800/70 bg-neutral-950/80 px-5 py-3 backdrop-blur">
      <div className="flex items-baseline gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-400">Now</span>
        {now ? (
          <>
            <span className="truncate text-sm font-medium text-neutral-100">{now.title}</span>
            <span className="shrink-0 text-xs tabular-nums text-neutral-500">
              {hhmm(now.start)} – {hhmm(now.stop)}
            </span>
            {channel?.archiveDays ? (
              <button
                onClick={() => usePlayback.getState().playCatchup(channel, now)}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
                title="Watch this programme from the beginning"
              >
                <RotateCcw className="h-3 w-3" />
                Start over
              </button>
            ) : null}
          </>
        ) : (
          <span className="text-xs text-neutral-500">No guide data</span>
        )}
      </div>
      {next && (
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Next</span>
          <span className="truncate text-sm text-neutral-400">{next.title}</span>
          <span className="shrink-0 text-xs tabular-nums text-neutral-600">{hhmm(next.start)}</span>
          {channel && <RemindButton channel={channel} programme={next} />}
        </div>
      )}
    </div>
  )
}

function RemindButton({ channel, programme }: { channel: Channel; programme: Programme }) {
  const on = useReminders((s) => s.items.some((r) => r.channel.id === channel.id && r.start === programme.start))
  const push = useToast((s) => s.push)
  return (
    <button
      onClick={() =>
        useReminders
          .getState()
          .toggle(channel, programme)
          .then((set) => push('success', set ? `We'll remind you at ${hhmm(programme.start)}` : 'Reminder removed'))
          .catch((e) => push('error', String(e)))
      }
      className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] ${
        on ? 'text-accent-300' : 'text-neutral-500 hover:text-neutral-200'
      }`}
      title={on ? 'Remove reminder' : 'Remind me when it starts'}
    >
      <Bell className={`h-3 w-3 ${on ? 'fill-current' : ''}`} />
      {on ? 'Reminder set' : 'Remind me'}
    </button>
  )
}
