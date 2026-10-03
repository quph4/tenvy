import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  Film,
  Folder,
  LayoutGrid,
  MonitorPlay,
  History as HistoryIcon,
  Pin,
  PinOff,
  Star,
  Tv,
} from 'lucide-react'
import { useMemo } from 'react'
import { FAVORITES_GROUP, HISTORY_GROUP, usePlaylist } from '../stores/playlist'
import type { ChannelKind, Group } from '../types'
import { cn } from '../lib/cn'
import { usePref } from '../lib/prefs'

/**
 * "provider" = whatever order the M3U / Xtream API handed us (curated by
 * the provider — what TiviMate calls "relevant"). "name" = A–Z.
 */
type GroupSort = 'provider' | 'name'

const KIND_TABS: { kind: ChannelKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'live', label: 'Live', icon: <Tv className="h-3.5 w-3.5" /> },
  { kind: 'movie', label: 'Movies', icon: <Film className="h-3.5 w-3.5" /> },
  { kind: 'series', label: 'Shows', icon: <MonitorPlay className="h-3.5 w-3.5" /> },
]

/**
 * Pinned groups are keyed per content-kind since a "News" group that
 * exists under Live has nothing to do with a "News" folder that might
 * appear under Movies. Shape: `{ live: [...], movie: [...], series: [...] }`.
 */
type PinnedMap = Partial<Record<ChannelKind, string[]>>

export function Sidebar() {
  const { groups, activeGroup, setActiveGroup, activeKind, setActiveKind } = usePlaylist()
  const [pinned, setPinned] = usePref<PinnedMap>('qanal.sidebar.pinned', {})
  const [sort, setSort] = usePref<GroupSort>('qanal.sidebar.groupSort', 'provider')

  const pins = pinned[activeKind] ?? []
  const { pinnedGroups, otherGroups } = useMemo(() => {
    // The backend already returns groups in provider order. For A–Z we
    // re-sort here; pinned groups ignore the toggle and always follow the
    // user's pinning sequence, which matches how TiviMate treats pins.
    const sorted =
      sort === 'name' ? [...groups].sort((a, b) => a.name.localeCompare(b.name)) : groups

    const bySlot: Group[] = []
    const rest: Group[] = []
    const pinIndex = new Map<string, number>()
    pins.forEach((name, i) => pinIndex.set(name, i))
    for (const g of sorted) {
      if (pinIndex.has(g.name)) bySlot.push(g)
      else rest.push(g)
    }
    bySlot.sort((a, b) => (pinIndex.get(a.name)! - pinIndex.get(b.name)!))
    return { pinnedGroups: bySlot, otherGroups: rest }
  }, [groups, pins, sort])

  const togglePin = (name: string) => {
    const current = pinned[activeKind] ?? []
    const next = current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name]
    setPinned({ ...pinned, [activeKind]: next })
  }

  return (
    <aside className="flex w-60 flex-col border-r border-zinc-800/70 bg-zinc-950/60">
      {/* Content-kind tabs. Switching swaps out the group list below. */}
      <div className="grid grid-cols-3 gap-1 border-b border-zinc-800/70 p-2">
        {KIND_TABS.map((t) => (
          <button
            key={t.kind}
            onClick={() => setActiveKind(t.kind)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors',
              activeKind === t.kind
                ? 'bg-zinc-800/80 text-zinc-100'
                : 'text-zinc-500 hover:bg-zinc-900/80 hover:text-zinc-300',
            )}
          >
            <span className={cn(activeKind === t.kind ? 'text-indigo-400' : 'text-zinc-500')}>
              {t.icon}
            </span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3 pt-2">
        <SidebarItem
          label="Favorites"
          icon={<Star className="h-3.5 w-3.5" />}
          active={activeGroup === FAVORITES_GROUP}
          onClick={() => setActiveGroup(FAVORITES_GROUP)}
          accent
        />
        <SidebarItem
          label="History"
          icon={<HistoryIcon className="h-3.5 w-3.5" />}
          active={activeGroup === HISTORY_GROUP}
          onClick={() => setActiveGroup(HISTORY_GROUP)}
          accent
        />
        <SidebarItem
          label={allLabelFor(activeKind)}
          icon={<LayoutGrid className="h-3.5 w-3.5" />}
          active={activeGroup === null}
          onClick={() => setActiveGroup(null)}
        />

        {pinnedGroups.length > 0 && (
          <>
            <div className="mt-3 mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
              Pinned
            </div>
            {pinnedGroups.map((g) => (
              <SidebarItem
                key={`pin-${g.name}`}
                label={g.name}
                icon={<Pin className="h-3.5 w-3.5 text-indigo-400" />}
                badge={g.count}
                active={activeGroup === g.name}
                onClick={() => setActiveGroup(g.name)}
                pinned
                onTogglePin={() => togglePin(g.name)}
              />
            ))}
          </>
        )}

        <div className="mt-3 mb-1 flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
          <span>Groups</span>
          <button
            onClick={() => setSort(sort === 'provider' ? 'name' : 'provider')}
            className="grid h-5 w-5 place-items-center rounded text-zinc-600 hover:bg-zinc-800/70 hover:text-zinc-300"
            aria-label="Toggle group sort"
            title={
              sort === 'provider'
                ? 'Sorted by provider order — click for A–Z'
                : 'Sorted A–Z — click for provider order'
            }
          >
            {sort === 'provider' ? (
              <ArrowDownWideNarrow className="h-3 w-3" />
            ) : (
              <ArrowDownAZ className="h-3 w-3" />
            )}
          </button>
        </div>

        {groups.length === 0 && (
          <div className="px-2 py-4 text-xs text-zinc-600">{emptyHintFor(activeKind)}</div>
        )}

        {otherGroups.map((g) => (
          <SidebarItem
            key={g.name}
            label={g.name}
            icon={<Folder className="h-3.5 w-3.5" />}
            badge={g.count}
            active={activeGroup === g.name}
            onClick={() => setActiveGroup(g.name)}
            onTogglePin={() => togglePin(g.name)}
          />
        ))}
      </nav>
    </aside>
  )
}

function allLabelFor(kind: ChannelKind): string {
  return kind === 'live' ? 'All channels' : kind === 'movie' ? 'All movies' : 'All shows'
}

function emptyHintFor(kind: ChannelKind): string {
  if (kind === 'live') return 'No live groups yet. Add a playlist to start.'
  if (kind === 'movie') return 'No movies in your playlist.'
  return 'No shows in your playlist.'
}

function SidebarItem({
  label,
  icon,
  badge,
  active,
  accent,
  pinned,
  onClick,
  onTogglePin,
}: {
  label: string
  icon: React.ReactNode
  badge?: number
  active?: boolean
  accent?: boolean
  pinned?: boolean
  onClick(): void
  onTogglePin?(): void
}) {
  return (
    <div
      className={cn(
        'group relative flex w-full items-center gap-2 rounded-md text-left text-sm transition-colors',
        active
          ? 'bg-zinc-800/80 text-zinc-100'
          : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200',
      )}
    >
      <button
        onClick={onClick}
        // `text-left` is the fix for the "names look centered" bug —
        // <button> defaults to text-align: center, which made the label
        // span sit in the middle of its flex cell instead of hugging the
        // icon.
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <span className={cn('shrink-0', accent ? 'text-indigo-400' : 'text-zinc-500')}>{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        {badge !== undefined && (
          <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
            {badge.toLocaleString()}
          </span>
        )}
      </button>
      {onTogglePin && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          className={cn(
            'mr-1 grid h-6 w-6 shrink-0 place-items-center rounded transition-all',
            pinned
              ? 'text-indigo-400 opacity-100 hover:bg-zinc-800/60'
              : 'text-zinc-600 opacity-0 hover:bg-zinc-800/60 hover:text-zinc-300 group-hover:opacity-100',
          )}
          aria-label={pinned ? 'Unpin group' : 'Pin group'}
          title={pinned ? 'Unpin' : 'Pin'}
        >
          {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        </button>
      )}
      {active && <span className="pointer-events-none absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-indigo-400" />}
    </div>
  )
}
