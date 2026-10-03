import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownAZ, ArrowDownWideNarrow, History, Star } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlayback } from '../stores/playback'
import { usePlaylist, HISTORY_GROUP } from '../stores/playlist'
import { useHistory, isResumable, fmtResume } from '../stores/history'
import { ipc } from '../lib/ipc'
import { useToast } from '../stores/toast'
import { cn } from '../lib/cn'
import { usePref } from '../lib/prefs'
import { useNowPlaying } from '../stores/nowPlaying'
import type { Channel, HistoryProgress } from '../types'
import { Trash2 } from 'lucide-react'

const ROW_HEIGHT = 56

/**
 * How to order channels in the list. "added" is insertion order from the
 * playlist — effectively date-added, since refresh replaces channels with
 * increasing sort_order. "name" is a simple locale compare.
 */
type SortMode = 'added' | 'name'

/**
 * The live-TV channel list. Movies and series are browsed in the library
 * (components/Library) instead.
 */
export function ChannelList() {
  const { channels, loadingChannels, activeGroup } = usePlaylist()
  const current = usePlayback((s) => s.channel)
  const play = usePlayback((s) => s.requestPlay)
  const isHistory = activeGroup === HISTORY_GROUP
  const [sort, setSort] = usePref<SortMode>('tenvy.channels.sort', 'added')

  const sortedChannels = useMemo(() => sortChannels(channels, sort), [channels, sort])

  const label =
    activeGroup === '__favorites' ? 'Favorites' : isHistory ? 'History' : activeGroup ?? 'All channels'

  return (
    <div className="flex w-80 shrink-0 flex-col border-r border-zinc-800/70 bg-zinc-950/40">
      <div className="flex h-10 items-center justify-between border-b border-zinc-800/70 px-4 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        <span className="truncate">{label}</span>
        <div className="flex items-center gap-2">
          {isHistory && sortedChannels.length > 0 && <ClearHistoryButton />}
          {!isHistory && <SortMenu value={sort} onChange={setSort} />}
          <span className="tabular-nums text-zinc-600">{sortedChannels.length.toLocaleString()}</span>
        </div>
      </div>

      {loadingChannels && channels.length === 0 && <ListSkeleton />}
      {!loadingChannels && channels.length === 0 && (
        <div className="grid flex-1 place-items-center px-6 text-center text-sm text-zinc-500">
          No channels here yet.
        </div>
      )}

      {isHistory && channels.length > 0 ? (
        <HistoryList currentChannelId={current?.id ?? null} onPlay={play} />
      ) : (
        <FlatList channels={sortedChannels} currentChannelId={current?.id ?? null} onPlay={play} />
      )}
    </div>
  )
}

// -------- sort helpers --------

function sortChannels(channels: Channel[], mode: SortMode): Channel[] {
  if (mode === 'added') {
    // Already in insertion order from the query, but re-sort to be safe —
    // favorites come out in toggle order, which isn't playlist order.
    return [...channels].sort((a, b) => a.sortOrder - b.sortOrder)
  }
  return [...channels].sort((a, b) => a.name.localeCompare(b.name))
}

function SortMenu({ value, onChange }: { value: SortMode; onChange(m: SortMode): void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const Icon = value === 'name' ? ArrowDownAZ : ArrowDownWideNarrow

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="grid h-6 w-6 place-items-center rounded text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
        aria-label="Sort"
        title={`Sort: ${value === 'name' ? 'Name' : 'Date added'}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 min-w-[11rem] overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/95 py-1 text-[11px] shadow-xl shadow-black/60 backdrop-blur">
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Sort by
          </div>
          <SortOption
            active={value === 'added'}
            icon={<ArrowDownWideNarrow className="h-3.5 w-3.5" />}
            label="Date added"
            onClick={() => {
              onChange('added')
              setOpen(false)
            }}
          />
          <SortOption
            active={value === 'name'}
            icon={<ArrowDownAZ className="h-3.5 w-3.5" />}
            label="Name (A–Z)"
            onClick={() => {
              onChange('name')
              setOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
}

function SortOption({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick(): void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left',
        active ? 'text-indigo-400' : 'text-zinc-200 hover:bg-zinc-800/80',
      )}
    >
      <span className={cn('shrink-0', active ? 'text-indigo-400' : 'text-zinc-500')}>{icon}</span>
      <span className="flex-1">{label}</span>
      {active && <span className="text-xs">●</span>}
    </button>
  )
}

// -------- flat list --------

function FlatList({
  channels,
  currentChannelId,
  onPlay,
}: {
  channels: Channel[]
  currentChannelId: number | null
  onPlay(ch: Channel): void
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: channels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
        {virt.getVirtualItems().map((row) => {
          const ch = channels[row.index]
          return (
            <div
              key={row.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                transform: `translateY(${row.start}px)`,
              }}
            >
              <ChannelRow
                channel={ch}
                active={currentChannelId === ch.id}
                onClick={() => onPlay(ch)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// -------- individual channel row --------

function ChannelRow({
  channel,
  active,
  onClick,
}: {
  channel: Channel
  active: boolean
  onClick(): void
}) {
  const [logoOk, setLogoOk] = useState(true)
  const now = useNowPlaying(channel.kind === 'live' ? channel.tvgId : null)
  const push = useToast((s) => s.push)
  const progress = useHistory((s) => s.progress.get(channel.id))

  const toggleFav = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const isFav = await ipc.toggleFavorite(channel.id)
      push('success', isFav ? `★ Added ${channel.name}` : `Removed ${channel.name}`)
    } catch (err) {
      push('error', String(err))
    }
  }

  return (
    <div
      role="button"
      onClick={onClick}
      className={cn(
        'group flex h-full items-center gap-3 border-b border-zinc-900/60 px-3 transition-colors',
        active ? 'bg-indigo-500/10 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900/60',
      )}
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-zinc-800 text-xs font-semibold text-zinc-500">
        {channel.logo && logoOk ? (
          <img
            src={channel.logo}
            alt=""
            loading="lazy"
            // See ShowRow — same hotlink-block story for movie posters.
            // Live-channel logos usually don't need this, but it doesn't
            // hurt them and unifies the behaviour across kinds.
            referrerPolicy="no-referrer"
            className="h-full w-full object-contain"
            onError={() => setLogoOk(false)}
          />
        ) : (
          channel.name.slice(0, 2).toUpperCase()
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{channel.name}</span>
          {channel.archiveDays ? (
            <span title={`Catch-up: ${channel.archiveDays} day(s)`} className="shrink-0 text-amber-400/70">
              <History className="h-3 w-3" />
            </span>
          ) : null}
          {active && <span className="h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-indigo-400" />}
        </div>
        <div className="truncate text-xs text-zinc-500">
          {now?.title ?? (channel.group ?? '—')}
        </div>
      </div>

      <button
        onClick={toggleFav}
        className="grid h-7 w-7 shrink-0 place-items-center rounded text-zinc-600 opacity-0 transition-all hover:text-amber-400 group-hover:opacity-100"
        aria-label="Toggle favorite"
      >
        <Star className="h-4 w-4" />
      </button>
      <ProgressStripe progress={progress} />
    </div>
  )
}

// -------- progress stripe / badge --------

/** Thin bar pinned to the bottom of a row, echoing the "keep watching"
 *  rails familiar from Netflix/Plex. We draw nothing for channels the
 *  user hasn't touched so the list stays quiet. */
export function ProgressStripe({ progress }: { progress: HistoryProgress | undefined }) {
  if (!progress) return null
  if (progress.finished) {
    return (
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-emerald-500/80" />
    )
  }
  if (!isResumable(progress)) return null
  const pct = Math.min(100, Math.max(1, (progress.timePos / progress.duration) * 100))
  return (
    <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-zinc-800">
      <span
        className="block h-full bg-indigo-400"
        style={{ width: `${pct.toFixed(2)}%` }}
      />
    </span>
  )
}

// -------- history view --------

function ClearHistoryButton() {
  const { push } = useToast()
  const onClick = async () => {
    if (!window.confirm('Clear all watch history? This cannot be undone.')) return
    try {
      await useHistory.getState().clear()
      await usePlaylist.getState().refreshChannels()
      push('success', 'History cleared')
    } catch (e) {
      push('error', String(e))
    }
  }
  return (
    <button
      onClick={onClick}
      className="grid h-6 w-6 place-items-center rounded text-zinc-500 hover:bg-zinc-800/70 hover:text-rose-300"
      aria-label="Clear history"
      title="Clear all history"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  )
}

function HistoryList({
  currentChannelId,
  onPlay,
}: {
  currentChannelId: number | null
  onPlay(ch: Channel): void
}) {
  // We reach into the zustand store for entries directly — the playlist
  // already populated it when the History group was activated, and
  // subscribing here keeps row deletion instant (no refetch round-trip).
  const entries = useHistory((s) => s.entries)
  const parentRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
        {virt.getVirtualItems().map((row) => {
          const entry = entries[row.index]
          return (
            <div
              key={row.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                transform: `translateY(${row.start}px)`,
              }}
            >
              <HistoryRow
                channel={entry.channel}
                progress={{
                  channelId: entry.channel.id,
                  timePos: entry.timePos,
                  duration: entry.duration,
                  watchedAt: entry.watchedAt,
                  finished: entry.finished,
                }}
                active={currentChannelId === entry.channel.id}
                onClick={() => onPlay(entry.channel)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HistoryRow({
  channel,
  progress,
  active,
  onClick,
}: {
  channel: Channel
  progress: HistoryProgress
  active: boolean
  onClick(): void
}) {
  const [logoOk, setLogoOk] = useState(true)
  const { push } = useToast()

  const onDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await useHistory.getState().remove(channel.id)
      // Keep the parent channel list in sync — entries drive `channels`
      // when the active group is History, and refreshChannels re-syncs.
      await usePlaylist.getState().refreshChannels()
      push('success', `Removed ${channel.name} from history`)
    } catch (err) {
      push('error', String(err))
    }
  }

  const watched = relativeTime(progress.watchedAt)
  let subtitle: string
  if (progress.finished) subtitle = `Watched · ${watched}`
  else if (isResumable(progress))
    subtitle = `${fmtResume(progress.timePos)} / ${fmtResume(progress.duration)} · ${watched}`
  else subtitle = watched

  return (
    <div
      role="button"
      onClick={onClick}
      className={cn(
        'group relative flex h-full items-center gap-3 border-b border-zinc-900/60 px-3 transition-colors',
        active ? 'bg-indigo-500/10 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900/60',
      )}
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-zinc-800 text-xs font-semibold text-zinc-500">
        {channel.logo && logoOk ? (
          <img
            src={channel.logo}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-contain"
            onError={() => setLogoOk(false)}
          />
        ) : (
          channel.name.slice(0, 2).toUpperCase()
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{channel.name}</span>
          {progress.finished && (
            <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
              Watched
            </span>
          )}
        </div>
        <div className="truncate text-xs text-zinc-500">{subtitle}</div>
      </div>
      <button
        onClick={onDelete}
        className="grid h-7 w-7 shrink-0 place-items-center rounded text-zinc-600 opacity-0 transition-all hover:text-rose-400 group-hover:opacity-100"
        aria-label="Remove from history"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <ProgressStripe progress={progress} />
    </div>
  )
}

/** "5m ago" / "2h ago" / "3d ago" — coarse enough that we don't need a
 *  ticker to keep it fresh, precise enough to tell a movie watched this
 *  afternoon apart from one from last weekend. */
function relativeTime(epochSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSeconds
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  const d = new Date(epochSeconds * 1000)
  return d.toLocaleDateString()
}

export function ListSkeleton() {
  return (
    <div className="flex flex-col gap-1 p-3">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-2">
          <div className="h-10 w-10 animate-pulse rounded-md bg-zinc-900" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-900" />
            <div className="h-2 w-1/3 animate-pulse rounded bg-zinc-900" />
          </div>
        </div>
      ))}
    </div>
  )
}
