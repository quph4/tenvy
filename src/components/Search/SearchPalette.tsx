import { Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import Fuse from 'fuse.js'
import { useUI } from '../../stores/ui'
import { usePlaylist } from '../../stores/playlist'
import { usePlayback } from '../../stores/playback'
import type { Channel } from '../../types'

export function SearchPalette() {
  const { searchOpen, closeSearch } = useUI()
  const { channels } = usePlaylist()
  const requestPlay = usePlayback((s) => s.requestPlay)
  const setView = useUI((s) => s.setView)
  // The Player only exists in the player view, so picking something here
  // has to switch back to it — otherwise playback starts out of sight.
  const play = (ch: Channel) => {
    requestPlay(ch)
    setView('player')
  }
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const fuse = useMemo(
    () =>
      new Fuse(channels, {
        keys: ['name', 'group'],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [channels],
  )

  const results: Channel[] = useMemo(() => {
    if (!q.trim()) return channels.slice(0, 50)
    return fuse.search(q).slice(0, 50).map((r) => r.item)
  }, [q, fuse, channels])

  useEffect(() => {
    if (searchOpen) {
      setQ('')
      setTimeout(() => inputRef.current?.focus(), 20)
    }
  }, [searchOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!searchOpen) return
      if (e.key === 'Escape') closeSearch()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searchOpen, closeSearch])

  if (!searchOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start bg-black/60 pt-24 backdrop-blur-sm animate-fade-in"
      onClick={closeSearch}
    >
      <div
        className="mx-auto w-full max-w-xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/95 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <SearchIcon className="h-4 w-4 text-zinc-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Channel name, group, programme…"
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 outline-none"
          />
          <button
            onClick={closeSearch}
            className="grid h-6 w-6 place-items-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <ul className="max-h-96 overflow-y-auto py-1">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-500">No matches.</li>
          )}
          {results.map((ch) => (
            <li key={ch.id}>
              <button
                onClick={() => {
                  play(ch)
                  closeSearch()
                }}
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800/80"
              >
                <div className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded bg-zinc-800 text-[10px] font-semibold text-zinc-500">
                  {ch.logo ? (
                    <img src={ch.logo} alt="" className="h-full w-full object-contain" />
                  ) : (
                    ch.name.slice(0, 2).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate">{ch.name}</div>
                  {ch.group && <div className="truncate text-xs text-zinc-500">{ch.group}</div>}
                </div>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-3 border-t border-zinc-800 bg-zinc-950/60 px-4 py-2 text-[11px] text-zinc-500">
          <span className="kbd">↵</span>
          <span>play</span>
          <span className="ml-auto kbd">Esc</span>
          <span>close</span>
        </div>
      </div>
    </div>
  )
}
