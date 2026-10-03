import { ArrowDownToLine, ChevronDown, Loader2, Search, Settings2 } from 'lucide-react'
import { TenvyMark } from './TenvyMark'
import { useUI } from '../stores/ui'
import { usePlaylist } from '../stores/playlist'
import { cn } from '../lib/cn'
import { useUpdater } from '../stores/updater'

export function Topbar() {
  const { openSearch, toggleSettings, setView, view } = useUI()
  const { sources, activeSourceId, setActiveSource } = usePlaylist()
  const activeSource = sources.find((s) => s.id === activeSourceId)

  return (
    <header className="flex h-12 items-center gap-3 border-b border-neutral-800/70 bg-neutral-950/80 px-4 backdrop-blur-md">
      <div className="flex items-center gap-2 text-neutral-100">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-neutral-800 to-neutral-950 ring-1 ring-white/10">
          <TenvyMark className="h-4 w-4 text-accent-400" />
        </div>
        <span className="text-sm font-semibold tracking-tight">Tenvy</span>
      </div>

      <button
        onClick={openSearch}
        className="group ml-2 flex h-8 flex-1 max-w-md items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/80 px-3 text-left text-sm text-neutral-500 transition-colors hover:border-neutral-700 hover:text-neutral-400"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">Search channels, movies and series…</span>
        <span className="kbd">Ctrl K</span>
      </button>

      <div className="ml-auto flex items-center gap-1">
        <UpdatePill />
        <div className="flex h-8 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900/80 text-xs">
          <button
            onClick={() => setView('player')}
            className={cn(
              'px-3 font-medium transition-colors',
              view === 'player' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
            )}
          >
            Live
          </button>
          <button
            onClick={() => setView('epg')}
            className={cn(
              'px-3 font-medium transition-colors',
              view === 'epg' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
            )}
          >
            Guide
          </button>
        </div>

        {sources.length > 0 && (
          <div className="relative">
            <select
              value={activeSourceId ?? ''}
              onChange={(e) => setActiveSource(Number(e.target.value))}
              className="h-8 appearance-none rounded-md border border-neutral-800 bg-neutral-900/80 pl-3 pr-8 text-xs font-medium text-neutral-300 hover:border-neutral-700"
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
            {activeSource && (
              <span className="sr-only">Active playlist: {activeSource.name}</span>
            )}
          </div>
        )}

        <button
          onClick={toggleSettings}
          className="grid h-8 w-8 place-items-center rounded-md border border-neutral-800 bg-neutral-900/80 text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-100"
          aria-label="Settings"
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </div>
    </header>
  )
}

/** Shown only while an update is available or downloading. */
function UpdatePill() {
  const status = useUpdater((s) => s.status)
  const install = useUpdater((s) => s.install)
  if (status.kind === 'available') {
    return (
      <button
        onClick={() => install()}
        title={status.notes ?? undefined}
        className="mr-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-400 px-3 text-xs font-semibold text-neutral-950 hover:bg-accent-300"
      >
        <ArrowDownToLine className="h-3.5 w-3.5" />
        Update to {status.version}
      </button>
    )
  }
  if (status.kind === 'downloading') {
    return (
      <span className="mr-1 inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-800 px-3 text-xs text-neutral-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Updating{status.progress != null ? ` ${Math.round(status.progress * 100)}%` : '…'}
      </span>
    )
  }
  return null
}
