import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePlaylist } from '../../stores/playlist'
import { usePlayback } from '../../stores/playback'
import { ipc } from '../../lib/ipc'
import { floorToMinutes, hhmm, HOUR, weekday } from '../../lib/time'
import type { Channel, Programme } from '../../types'
import { cn } from '../../lib/cn'
import { useUI } from '../../stores/ui'

const ROW_HEIGHT = 56
const CHANNEL_COL_WIDTH = 220
const PIXELS_PER_HOUR = 240 // 30min = 120px
const WINDOW_HOURS = 24
const HISTORY_HOURS = 2

export function EPGGrid() {
  const { channels } = usePlaylist()
  const requestPlay = usePlayback((s) => s.requestPlay)
  const setView = useUI((s) => s.setView)
  // The Player only exists in the player view, so picking something here
  // has to switch back to it — otherwise playback starts out of sight.
  const play = (ch: Channel) => {
    requestPlay(ch)
    setView('player')
  }

  const nowEpoch = Math.floor(Date.now() / 1000)
  const windowStart = useMemo(() => floorToMinutes(nowEpoch - HISTORY_HOURS * HOUR, 30), [nowEpoch])
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
  }, [rowVirtualizer.getVirtualItems().map((v) => v.index).join(','), channels, windowStart, windowEnd])

  // Scroll so "now" is roughly one-third in
  useEffect(() => {
    if (!scrollerRef.current) return
    const nowX = (nowEpoch - windowStart) * pxPerSec
    scrollerRef.current.scrollLeft = Math.max(0, nowX - scrollerRef.current.clientWidth / 3)
  }, [])

  const timeSlots: number[] = []
  for (let t = windowStart; t < windowEnd; t += 1800) timeSlots.push(t)

  return (
    <div className="flex flex-1 flex-col bg-zinc-950 overflow-hidden">
      <div className="flex h-10 shrink-0 items-center border-b border-zinc-800/70 bg-zinc-950/80 px-5 text-xs text-zinc-500">
        <span className="font-semibold uppercase tracking-wider text-zinc-400">Guide</span>
        <span className="ml-3 text-zinc-600">{weekday(nowEpoch)} · {hhmm(nowEpoch)}</span>
        <span className="ml-auto text-zinc-600">
          {channels.length.toLocaleString()} channels · {WINDOW_HOURS}h window
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
                      return (
                        <button
                          key={`${p.channelTvgId}-${p.start}`}
                          onClick={() => play(ch)}
                          className={cn(
                            'absolute top-1 bottom-1 rounded-md border px-2 py-1 text-left text-xs transition-colors',
                            isNow
                              ? 'border-indigo-500/40 bg-indigo-500/10 text-zinc-100 hover:bg-indigo-500/20'
                              : 'border-zinc-800/60 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80',
                          )}
                          style={{ left, width }}
                          title={`${p.title}\n${hhmm(p.start)} – ${hhmm(p.stop)}`}
                        >
                          <div className="truncate font-medium">{p.title}</div>
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

          {/* Now line */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-red-500/70"
            style={{ left: CHANNEL_COL_WIDTH + (nowEpoch - windowStart) * pxPerSec }}
          >
            <div className="absolute -left-1 top-8 h-2 w-2 rounded-full bg-red-500" />
          </div>
        </div>
      </div>
    </div>
  )
}
