import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { listen } from '@tauri-apps/api/event'
import { usePlaylist } from '../../stores/playlist'
import { usePlayback } from '../../stores/playback'
import { ipc, subscribe } from '../../lib/ipc'
import { DAY, floorToMinutes, hhmm, HOUR, weekday } from '../../lib/time'
import { ChevronLeft, ChevronRight, History } from 'lucide-react'
import type { Channel, Programme } from '../../types'
import { cn } from '../../lib/cn'
import { useUI } from '../../stores/ui'

const ROW_HEIGHT = 56
const CHANNEL_COL_WIDTH = 220
const PIXELS_PER_HOUR = 240 // 30min = 120px
const WINDOW_HOURS = 24
const HISTORY_HOURS = 2
/** How far the guide pages back/forward, in days. */
const MAX_DAYS = 7

export function EPGGrid() {
  const { channels } = usePlaylist()
  const requestPlay = usePlayback((s) => s.requestPlay)
  const playCatchup = usePlayback((s) => s.playCatchup)
  const setView = useUI((s) => s.setView)
  // The Player only exists in the player view, so picking something here
  // has to switch back to it — otherwise playback starts out of sight.
  const play = (ch: Channel) => {
    requestPlay(ch)
    setView('player')
  }
  // A programme that has already aired plays from the provider's archive
  // when the channel has catch-up reaching back far enough; anything else
  // tunes to the live channel.
  const canCatchUp = (ch: Channel, p: Programme) =>
    !!ch.archiveDays && p.start < nowEpoch && p.start >= nowEpoch - ch.archiveDays * DAY
  const openProgramme = (ch: Channel, p: Programme) => {
    if (p.stop <= nowEpoch && canCatchUp(ch, p)) {
      playCatchup(ch, p)
      setView('player')
    } else {
      play(ch)
    }
  }

  // Ticks once a minute so the "now" line and highlighting move.
  const [nowEpoch, setNowEpoch] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = window.setInterval(() => setNowEpoch(Math.floor(Date.now() / 1000)), 60_000)
    return () => window.clearInterval(t)
  }, [])
  // Day paging: 0 = the window around now; ±n shifts it by whole days,
  // limited to the week either side that guides and archives cover.
  const [dayOffset, setDayOffset] = useState(0)
  const windowStart = floorToMinutes(nowEpoch - HISTORY_HOURS * HOUR, 30) + dayOffset * DAY
  const windowEnd = windowStart + WINDOW_HOURS * HOUR
  const pxPerSec = PIXELS_PER_HOUR / HOUR
  const totalWidth = (windowEnd - windowStart) * pxPerSec

  const scrollerRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
  })

  const [programmes, setProgrammes] = useState<Map<string, Programme[]>>(new Map())

  // Cached rows are only valid for one window and one version of the
  // guide: drop them when the window slides or a new guide lands.
  useEffect(() => {
    setProgrammes(new Map())
  }, [windowStart])
  useEffect(() => subscribe(() => listen('guide-updated', () => setProgrammes(new Map()))), [])

  // Load programmes for the visible rows
  useEffect(() => {
    const rows = rowVirtualizer.getVirtualItems()
    if (rows.length === 0) return
    const ids = rows
      .map((r) => channels[r.index]?.tvgId)
      .filter((x): x is string => !!x)
    if (ids.length === 0) return
    // De-dup: only fetch ids we haven't loaded
    const missing = ids.filter((id) => !programmes.has(id))
    if (missing.length === 0) return

    let cancelled = false
    ipc
      .programmesForChannels({ tvgIds: missing, from: windowStart, to: windowEnd })
      .then((progs) => {
        if (cancelled) return
        setProgrammes((prev) => {
          const next = new Map(prev)
          for (const id of missing) next.set(id, [])
          for (const p of progs) {
            const arr = next.get(p.channelTvgId) ?? []
            arr.push(p)
            next.set(p.channelTvgId, arr)
          }
          return next
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  // `programmes` is a dependency so a reset (new guide, new window) refetches
  // the rows on screen; the `missing` filter keeps it from looping.
  }, [rowVirtualizer.getVirtualItems().map((v) => v.index).join(','), channels, windowStart, windowEnd, programmes])

  // Scroll so "now" is roughly one-third in; other days start at the left.
  useEffect(() => {
    if (!scrollerRef.current) return
    const nowX = (nowEpoch - windowStart) * pxPerSec
    scrollerRef.current.scrollLeft =
      dayOffset === 0 ? Math.max(0, nowX - scrollerRef.current.clientWidth / 3) : 0
    // Only on day changes — not on every minute tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayOffset])

  const timeSlots: number[] = []
  for (let t = windowStart; t < windowEnd; t += 1800) timeSlots.push(t)

  return (
    <div className="flex flex-1 flex-col bg-zinc-950 overflow-hidden">
      <div className="flex h-10 shrink-0 items-center border-b border-zinc-800/70 bg-zinc-950/80 px-5 text-xs text-zinc-500">
        <span className="font-semibold uppercase tracking-wider text-zinc-400">Guide</span>
        <span className="ml-3 text-zinc-600">{weekday(windowStart + HISTORY_HOURS * HOUR)}</span>
        <div className="ml-4 flex items-center gap-1">
          <DayButton disabled={dayOffset <= -MAX_DAYS} onClick={() => setDayOffset(dayOffset - 1)} label="Previous day">
            <ChevronLeft className="h-3.5 w-3.5" />
          </DayButton>
          <button
            onClick={() => setDayOffset(0)}
            disabled={dayOffset === 0}
            className="h-6 rounded px-2 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600 disabled:hover:bg-transparent"
          >
            Now
          </button>
          <DayButton disabled={dayOffset >= MAX_DAYS} onClick={() => setDayOffset(dayOffset + 1)} label="Next day">
            <ChevronRight className="h-3.5 w-3.5" />
          </DayButton>
        </div>
        <span className="ml-auto flex items-center gap-3 text-zinc-600">
          <span className="inline-flex items-center gap-1">
            <History className="h-3 w-3 text-amber-400/80" /> catch-up
          </span>
          {channels.length.toLocaleString()} channels
        </span>
      </div>

      <div ref={scrollerRef} className="relative flex-1 overflow-auto">
        <div style={{ width: CHANNEL_COL_WIDTH + totalWidth, position: 'relative' }}>
          {/* Sticky time ruler */}
          <div
            className="sticky top-0 z-20 flex h-8 border-b border-zinc-800/70 bg-zinc-950/95 backdrop-blur"
            style={{ width: CHANNEL_COL_WIDTH + totalWidth }}
          >
            <div
              className="sticky left-0 z-30 shrink-0 border-r border-zinc-800/70 bg-zinc-950"
              style={{ width: CHANNEL_COL_WIDTH }}
            />
            {timeSlots.map((t) => (
              <div
                key={t}
                className="shrink-0 border-r border-zinc-900/80 px-2 text-[11px] tabular-nums leading-8 text-zinc-500"
                style={{ width: PIXELS_PER_HOUR / 2 }}
              >
                {hhmm(t)}
              </div>
            ))}
          </div>

          {/* Body: virtualized rows */}
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((v) => {
              const ch = channels[v.index]
              const progs = ch.tvgId ? programmes.get(ch.tvgId) ?? [] : []
              return (
                <div
                  key={v.key}
                  className="absolute left-0 right-0 flex border-b border-zinc-900/70"
                  style={{ top: v.start, height: ROW_HEIGHT }}
                >
                  <div
                    className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-zinc-800/70 bg-zinc-950/95 px-3 text-sm backdrop-blur"
                    style={{ width: CHANNEL_COL_WIDTH }}
                  >
                    <div className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded bg-zinc-800 text-[10px] font-semibold text-zinc-500">
                      {ch.logo ? (
                        <img src={ch.logo} alt="" className="h-full w-full object-contain" />
                      ) : (
                        ch.name.slice(0, 2).toUpperCase()
                      )}
                    </div>
                    <span className="truncate text-zinc-200">{ch.name}</span>
                  </div>

                  <div className="relative flex-1" style={{ minWidth: totalWidth }}>
                    {progs.map((p) => {
                      const left = Math.max(0, (p.start - windowStart) * pxPerSec)
                      const right = Math.min(totalWidth, (p.stop - windowStart) * pxPerSec)
                      const width = Math.max(2, right - left)
                      const isNow = nowEpoch >= p.start && nowEpoch < p.stop
                      const isPast = p.stop <= nowEpoch
                      const catchUp = isPast && canCatchUp(ch, p)
                      return (
                        <button
                          key={`${p.channelTvgId}-${p.start}`}
                          onClick={() => openProgramme(ch, p)}
                          className={cn(
                            'absolute top-1 bottom-1 rounded-md border px-2 py-1 text-left text-xs transition-colors',
                            isNow
                              ? 'border-indigo-500/40 bg-indigo-500/10 text-zinc-100 hover:bg-indigo-500/20'
                              : catchUp
                                ? 'border-amber-500/20 bg-zinc-900/70 text-zinc-300 hover:border-amber-500/40 hover:bg-zinc-800/80'
                                : isPast
                                  ? 'border-zinc-900/60 bg-zinc-950/60 text-zinc-500 hover:bg-zinc-900/80'
                                  : 'border-zinc-800/60 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80',
                          )}
                          style={{ left, width }}
                          title={[
                            p.title,
                            `${hhmm(p.start)} – ${hhmm(p.stop)}`,
                            catchUp ? 'Click to watch (catch-up)' : null,
                            p.description,
                          ]
                            .filter(Boolean)
                            .join('\n')}
                        >
                          <div className="flex items-center gap-1 font-medium">
                            {catchUp && <History className="h-3 w-3 shrink-0 text-amber-400/80" />}
                            <span className="truncate">{p.title}</span>
                          </div>
                          <div className="truncate text-[10px] tabular-nums text-zinc-500">
                            {hhmm(p.start)} – {hhmm(p.stop)}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Now line (only when "now" is inside the shown window) */}
          {nowEpoch >= windowStart && nowEpoch < windowEnd && <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-red-500/70"
            style={{ left: CHANNEL_COL_WIDTH + (nowEpoch - windowStart) * pxPerSec }}
          >
            <div className="absolute -left-1 top-8 h-2 w-2 rounded-full bg-red-500" />
          </div>}
        </div>
      </div>
    </div>
  )
}

function DayButton({
  disabled,
  onClick,
  label,
  children,
}: {
  disabled: boolean
  onClick(): void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid h-6 w-6 place-items-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}
