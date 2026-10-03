import {
  Captions,
  CaptionsOff,
  ExternalLink,
  Languages,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useState } from 'react'
import { usePlayback } from '../../stores/playback'
import { useToast } from '../../stores/toast'
import { ipc } from '../../lib/ipc'
import { cn } from '../../lib/cn'

export type PickerKind = 'audio' | 'subtitle' | null

/**
 * Docked control strip shown under the video surface.
 *
 * Picker state is owned by Player — Controls only toggles it. That lets the
 * picker render as a right-side drawer that narrows the video column
 * smoothly, rather than growing this strip vertically and shoving the
 * native mpv HWND downward in a visible jerk.
 */
export function Controls({
  onToggleFullscreen,
  activePicker,
  onTogglePicker,
}: {
  onToggleFullscreen(): void
  activePicker: PickerKind
  onTogglePicker(kind: PickerKind): void
}) {
  const {
    playing,
    setPlaying,
    volume,
    setVolume,
    muted,
    toggleMute,
    fullscreen,
    channel,
    currentSubtitle,
    timePos,
    duration,
  } = usePlayback()
  const { push } = useToast()

  if (!channel) return null

  const isVod = channel.kind === 'movie' || channel.kind === 'series'

  const openExternal = async () => {
    try {
      const s = usePlayback.getState()
      const audioTrack = s.currentAudio ?? s.preferredAudioTrack
      const subtitleTrack = s.currentSubtitle ?? s.preferredSubtitleTrack
      const player = await ipc.openExternal(channel.id, { audioTrack, subtitleTrack })
      const name = player.split(/[\\/]/).pop() ?? player
      push('success', `Launched ${name}`)
    } catch (e) {
      push('error', String(e))
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-zinc-800/70 bg-zinc-950/95 px-4 py-2">
      {isVod && <ScrubRow timePos={timePos} duration={duration} />}

      <div className="flex items-center gap-3">
        <button
          onClick={() => setPlaying(!playing)}
          className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-[1px]" />}
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={toggleMute}
            className="grid h-8 w-8 place-items-center rounded-full text-white/90 hover:bg-white/10"
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-white/20 accent-indigo-400"
            aria-label="Volume"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="mr-1 hidden max-w-[20rem] truncate text-xs text-white/70 sm:block">
            {channel.name}
          </div>

          {isVod && (
            <>
              <button
                onClick={() => onTogglePicker(activePicker === 'audio' ? null : 'audio')}
                className={cn(
                  'grid h-8 w-8 place-items-center rounded-full text-white/90 hover:bg-white/10',
                  activePicker === 'audio' && 'bg-white/10',
                )}
                aria-label="Audio track"
                title="Audio track"
              >
                <Languages className="h-4 w-4" />
              </button>
              <button
                onClick={() => onTogglePicker(activePicker === 'subtitle' ? null : 'subtitle')}
                className={cn(
                  'grid h-8 w-8 place-items-center rounded-full text-white/90 hover:bg-white/10',
                  activePicker === 'subtitle' && 'bg-white/10',
                )}
                aria-label="Subtitles"
                title="Subtitles"
              >
                {currentSubtitle != null ? (
                  <Captions className="h-4 w-4" />
                ) : (
                  <CaptionsOff className="h-4 w-4" />
                )}
              </button>
            </>
          )}

          <button
            onClick={openExternal}
            className="grid h-8 w-8 place-items-center rounded-full text-white/90 hover:bg-white/10"
            aria-label="Open in external player (X)"
            title="Open in mpv / VLC (X)"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          <button
            onClick={onToggleFullscreen}
            className="grid h-8 w-8 place-items-center rounded-full text-white/90 hover:bg-white/10"
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}

function ScrubRow({
  timePos,
  duration,
}: {
  timePos: number | null
  duration: number | null
}) {
  const [scrubbing, setScrubbing] = useState<number | null>(null)
  const safeDuration = duration && duration > 0 ? duration : 0
  const displayedTime = scrubbing ?? timePos ?? 0

  const commit = (value: number) => {
    if (safeDuration) {
      ipc.mpvSeek(Math.max(0, Math.min(safeDuration, value))).catch(() => {})
    }
    setScrubbing(null)
  }

  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-[11px] tabular-nums text-white/80">
        {fmtTime(displayedTime)}
      </span>
      <input
        type="range"
        min={0}
        max={safeDuration || 1}
        step={0.1}
        disabled={!safeDuration}
        value={displayedTime}
        onChange={(e) => setScrubbing(Number(e.target.value))}
        onMouseUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => commit(Number((e.target as HTMLInputElement).value))}
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-white/20 accent-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Seek"
      />
      <span className="shrink-0 text-[11px] tabular-nums text-white/60">
        {safeDuration ? fmtTime(safeDuration) : '--:--'}
      </span>
    </div>
  )
}

function fmtTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '--:--'
  const s = Math.floor(secs)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`
}
