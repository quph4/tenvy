import { Film, MonitorPlay, Search as SearchIcon, Tv, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useUI } from '../../stores/ui'
import { usePlaylist } from '../../stores/playlist'
import { usePlayback } from '../../stores/playback'
import { ipc } from '../../lib/ipc'
import { cn } from '../../lib/cn'
import type { Channel, ChannelKind } from '../../types'

const KIND_ICON: Record<ChannelKind, React.ReactNode> = {
  live: <Tv className="h-3 w-3" />,
  movie: <Film className="h-3 w-3" />,
  series: <MonitorPlay className="h-3 w-3" />,
}

/**
 * Ctrl+K palette. Searches the whole active playlist — every group and
 * content kind — in SQLite, not just the list on screen.
 */
export function SearchPalette() {
  const searchOpen = useUI((s) => s.searchOpen)
  const closeSearch = useUI((s) => s.closeSearch)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Channel[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (searchOpen) {
      setQ('')
      setResults([])
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 20)
    }
  }, [searchOpen])

  // Debounced query. Stale responses are dropped so fast typing can't
  // leave an older result set on screen.
  useEffect(() => {
    if (!searchOpen) return
    const query = q.trim()
    if (!query) {
      setResults([])
      return
    }
    let cancelled = false
    const t = window.setTimeout(() => {
      const sourceId = usePlaylist.getState().activeSourceId
      ipc
        .searchChannels(query, { sourceId })
        .then((rows) => {
          if (cancelled) return
          setResults(rows.slice(0, 100))
          setSelected(0)
        })
        .catch(() => {})
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [q, searchOpen])

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const pick = (ch: Channel) => {
    closeSearch()
    // The Player only exists in the player view, so picking something has
    // to switch back to it — otherwise playback starts out of sight.
    useUI.getState().setView('player')
    // Live channels play; movies and series open their details page.
    if (ch.kind === 'live') {
      usePlayback.getState().requestPlay(ch)
    } else {
      usePlaylist.getState().openDetails(ch).catch(() => {})
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[selected]) {
      e.preventDefault()
      pick(results[selected])
    }
  }

  if (!searchOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start bg-black/60 pt-24 backdrop-blur-sm animate-fade-in"
      onClick={closeSearch}
    >
      <div
        className="mx-auto w-full max-w-xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/95 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <SearchIcon className="h-4 w-4 text-zinc-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Channels, movies and series…"
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 outline-none"
          />
          <button
            onClick={closeSearch}
            className="grid h-6 w-6 place-items-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            aria-label="Close search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <ul ref={listRef} className="max-h-96 overflow-y-auto py-1">
          {q.trim() && results.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-500">No matches.</li>
          )}
          {results.map((ch, i) => (
            <li key={ch.id}>
              <button
                onClick={() => pick(ch)}
                onMouseMove={() => setSelected(i)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-zinc-300',
                  i === selected && 'bg-zinc-800/80',
                )}
              >
                <div className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded bg-zinc-800 text-[10px] font-semibold text-zinc-500">
                  {ch.logo ? (
                    <img src={ch.logo} alt="" referrerPolicy="no-referrer" className="h-full w-full object-contain" />
                  ) : (
                    ch.name.slice(0, 2).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate">{ch.name}</div>
                  {ch.group && <div className="truncate text-xs text-zinc-500">{ch.group}</div>}
                </div>
                <span className="shrink-0 text-zinc-600">{KIND_ICON[ch.kind]}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-3 border-t border-zinc-800 bg-zinc-950/60 px-4 py-2 text-[11px] text-zinc-500">
          <span className="kbd">↑↓</span>
          <span>select</span>
          <span className="kbd">↵</span>
          <span>open</span>
          <span className="ml-auto kbd">Esc</span>
          <span>close</span>
        </div>
      </div>
    </div>
  )
}
