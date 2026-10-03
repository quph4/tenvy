import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownAZ, ArrowDownWideNarrow, History, MoreVertical, Star } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlayback } from '../stores/playback'
import { usePlaylist, HISTORY_GROUP, FAVORITES_GROUP } from '../stores/playlist'
import { isSeparator, separatorTitle, sortChannels, SORT_KEY, type SortMode } from '../lib/channels'
import { useChannelMenu } from './ChannelMenu'
import { useHistory, isResumable, fmtResume } from '../stores/history'
import { ipc } from '../lib/ipc'
import { useToast } from '../stores/toast'
import { cn } from '../lib/cn'
import { usePref } from '../lib/prefs'
import { useNowPlaying } from '../stores/nowPlaying'
import type { Channel, HistoryProgress } from '../types'
import { Trash2 } from 'lucide-react'

const ROW_HEIGHT = 56
/** Section titles from the provider ("-= Sweden =-") are slimmer. */
const SEPARATOR_HEIGHT = 30

/**
 * The live-TV channel list. Movies and series are browsed in the library
 * (components/Library) instead.
 */
export function ChannelList() {
  const { channels, loadingChannels, activeGroup } = usePlaylist()
  const current = usePlayback((s) => s.channel)
  const play = usePlayback((s) => s.requestPlay)
  const isHistory = activeGroup === HISTORY_GROUP
  const [sort, setSort] = usePref<SortMode>(SORT_KEY, 'added')
  const isFavorites = activeGroup === FAVORITES_GROUP

  // Favorites keep the viewer's own order (reordered from the ⋯ menu).
  const sortedChannels = useMemo(() => sortChannels(channels, sort, isFavorites), [channels, sort, isFavorites])
  const playable = useMemo(() => sortedChannels.filter((c) => !isSeparator(c)), [sortedChannels])

  const label =
    activeGroup === '__favorites' ? 'Favorites' : isHistory ? 'History' : activeGroup ?? 'All channels'

  return (
    <div className="flex w-80 shrink-0 flex-col border-r border-neutral-800/70 bg-neutral-950/40">
      <div className="flex h-10 items-center justify-between border-b border-neutral-800/70 px-4 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
        <span className="truncate">{label}</span>
        <div className="flex items-center gap-2">
          {isHistory && sortedChannels.length > 0 && <ClearHistoryButton />}
          {!isHistory && !isFavorites && <SortMenu value={sort} onChange={setSort} />}
          <span className="tabular-nums text-neutral-600">{playable.length.toLocaleString()}</span>
        </div>
      </div>

      {loadingChannels && channels.length === 0 && <ListSkeleton />}
      {!loadingChannels && channels.length === 0 && (
        <div className="grid flex-1 place-items-center px-6 text-center text-sm text-neutral-500">
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
        className="grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-neutral-800/70 hover:text-neutral-200"
        aria-label="Sort"
        title={`Sort: ${value === 'name' ? 'Name' : 'Date added'}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 min-w-[11rem] overflow-hidden rounded-md border border-neutral-800 bg-neutral-900/95 py-1 text-[11px] shadow-xl shadow-black/60 backdrop-blur">
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
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
        active ? 'text-accent-400' : 'text-neutral-200 hover:bg-neutral-800/80',
      )}
    >
      <span className={cn('shrink-0', active ? 'text-accent-400' : 'text-neutral-500')}>{icon}</span>
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
  // Channel numbers as ↑/↓ and the digit keys see them: section titles
  // don't count.
  // Only live channels are numbered — films in Favorites aren't zappable.
  const numbers = useMemo(() => {
    const m = new Map<number, number>()
    let n = 0
    for (const c of channels) if (c.kind === 'live' && !isSeparator(c)) m.set(c.id, ++n)
    return m
  }, [channels])
  const virt = useVirtualizer({
    count: channels.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (i) => channels[i].id,
    estimateSize: (i) => (isSeparator(channels[i]) ? SEPARATOR_HEIGHT : ROW_HEIGHT),
    overscan: 10,
  })
  // Row heights depend on which rows are headings; re-measure when the
  // order changes even if the count doesn't (sorting A–Z).
  useEffect(() => {
    virt.measure()
  }, [channels, virt])

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
        {virt.getVirtualItems().map((row) => {
          const ch = channels[row.index]
          const separator = isSeparator(ch)
          return (
            <div
              key={row.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: separator ? SEPARATOR_HEIGHT : ROW_HEIGHT,
                transform: `translateY(${row.start}px)`,
              }}
            >
              {separator ? (
                <div className="flex h-full items-end border-b border-neutral-800/70 px-4 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent-400/80">
                  {separatorTitle(ch.name)}
                </div>
              ) : (
                <ChannelRow
                  channel={ch}
                  number={numbers.get(ch.id) ?? null}
                  active={currentChannelId === ch.id}
                  onClick={() => onPlay(ch)}
                />
              )}
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
  number,
  active,
  onClick,
}: {
  channel: Channel
  number?: number | null
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
      onContextMenu={(e) => {
        e.preventDefault()
        useChannelMenu.getState().show(channel, e.clientX, e.clientY)
      }}
      className={cn(
        'group flex h-full items-center gap-3 border-b border-neutral-900/60 px-3 transition-colors',
        active ? 'bg-accent-500/10 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-900/60',
      )}
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-neutral-800 text-xs font-semibold text-neutral-500">
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
          {number != null && <span className="shrink-0 text-[11px] tabular-nums text-neutral-600">{number}</span>}
          <span className="truncate text-sm font-medium">{channel.name}</span>
          {channel.archiveDays ? (
            <span title={`Catch-up: ${channel.archiveDays} day(s)`} className="shrink-0 text-amber-400/70">
              <History className="h-3 w-3" />
            </span>
          ) : null}
          {active && <span className="h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-accent-400" />}
        </div>
        <div className="truncate text-xs text-neutral-500">
          {now?.title ?? (channel.group ?? '—')}
        </div>
      </div>

      <button
        onClick={toggleFav}
        className="grid h-7 w-7 shrink-0 place-items-center rounded text-neutral-600 opacity-0 transition-all hover:text-amber-400 group-hover:opacity-100"
        aria-label="Toggle favorite"
      >
        <Star className="h-4 w-4" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          useChannelMenu.getState().show(channel, r.left, r.bottom + 4)
        }}
        className="-ml-2 grid h-7 w-6 shrink-0 place-items-center rounded text-neutral-600 opacity-0 transition-all hover:text-neutral-200 group-hover:opacity-100"
        aria-label="More"
        title="More"
      >
        <MoreVertical className="h-4 w-4" />
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
    <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-neutral-800">
      <span
        className="block h-full bg-accent-400"
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
      className="grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-neutral-800/70 hover:text-rose-300"
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
        'group relative flex h-full items-center gap-3 border-b border-neutral-900/60 px-3 transition-colors',
        active ? 'bg-accent-500/10 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-900/60',
      )}
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-neutral-800 text-xs font-semibold text-neutral-500">
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
        <div className="truncate text-xs text-neutral-500">{subtitle}</div>
      </div>
      <button
        onClick={onDelete}
        className="grid h-7 w-7 shrink-0 place-items-center rounded text-neutral-600 opacity-0 transition-all hover:text-rose-400 group-hover:opacity-100"
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
          <div className="h-10 w-10 animate-pulse rounded-md bg-neutral-900" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-900" />
            <div className="h-2 w-1/3 animate-pulse rounded bg-neutral-900" />
          </div>
        </div>
      ))}
    </div>
  )
}
